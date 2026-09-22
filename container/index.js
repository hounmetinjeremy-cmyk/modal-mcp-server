// container/index.js
// Vrai serveur MCP tournant dans un Cloudflare Container (Node.js complet)
// avec sandbox Modal + terminal persistant.

import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { ModalClient } = require("modal");

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());

// -------- Identifiants Modal --------
function getModalClient() {
  const tokenId = process.env.MODAL_TOKEN_ID;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new Error("MODAL_TOKEN_ID / MODAL_TOKEN_SECRET requis.");
  }
  return new ModalClient({ tokenId, tokenSecret });
}

// -------- Gestion des sessions terminales --------
// Une session = un sandbox Modal + un shell bash persistant + des jobs.
const sessions = new Map(); // sessionId -> { sandbox, shell, cwd, jobs, createdAt, lastSeen }
const FIFO_CMD = "/tmp/mcp_terminal_cmd";
const FIFO_OUT = "/tmp/mcp_terminal_out";
const FIFO_PID = "/tmp/mcp_terminal.pid";
const BG_LOG_DIR = "/tmp/mcp_jobs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureFifo(sandbox) {
  await sandbox.exec(`mkdir -p '${BG_LOG_DIR}' && rm -f '${FIFO_CMD}' '${FIFO_OUT}' '${FIFO_PID}'`);
  await sandbox.exec(`mkfifo '${FIFO_CMD}' '${FIFO_OUT}'`);

  // Daemon bash persistant
  const daemon = `
    cd /home/user 2>/dev/null || cd /
    exec bash -c '
      while true; do
        cmd=$(cat ${FIFO_CMD})
        [ "$cmd" = "__EXIT__" ] && break
        cwd=$(head -n1 /tmp/mcp_cwd 2>/dev/null || echo "/home/user")
        cd "$cwd" 2>/dev/null || cd /
        eval "$cmd" >> ${FIFO_OUT} 2>&1
        echo "___MCP_EOF___" >> ${FIFO_OUT}
        pwd > /tmp/mcp_cwd
      done
    ' &
    echo $! > ${FIFO_PID}
  `;
  await sandbox.exec(daemon);
  await sleep(500);
}

async function sessionFromId(modal, sessionId) {
  let sess = sessions.get(sessionId);
  if (sess) {
    sess.lastSeen = Date.now();
    return sess;
  }

  const sandbox = await modal.Sandbox.create({
    image: "python:3.12-slim",
    timeout: 600,
    cpu: 2,
    memory: 2048,
    mounts: [],
    secrets: [],
  });

  await ensureFifo(sandbox);

  sess = {
    id: sessionId,
    sandbox,
    cwd: "/home/user",
    jobs: [],
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  sessions.set(sessionId, sess);
  return sess;
}

async function sendCommand(sandbox, command) {
  // Injecte la commande dans le FIFO
  await sandbox.exec(`printf '%s' ${shellEscape(command)} > ${FIFO_CMD}`);

  // Attend la fin via marqueur
  const start = Date.now();
  let output = "";
  while (Date.now() - start < 30_000) {
    const chunk = await sandbox.exec(`cat ${FIFO_OUT} 2>/dev/null || true`);
    output += chunk.stdout ?? "";
    if (output.includes("___MCP_EOF___")) break;
    await sleep(200);
  }

  const cleaned = output
    .split("\n")
    .filter((l) => l !== "___MCP_EOF___")
    .join("\n");

  const cwdRaw = await sandbox.exec(`cat /tmp/mcp_cwd 2>/dev/null || echo /home/user`);
  const cwd = (cwdRaw.stdout ?? "/home/user").trim();
  return { output: cleaned, cwd };
}

function shellEscape(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

async function runInBackground(sandbox, command, session) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const logFile = `${BG_LOG_DIR}/${jobId}.log`;
  const escaped = shellEscape(command);
  const cwd = (await sandbox.exec(`cat /tmp/mcp_cwd 2>/dev/null || echo /home/user`)).stdout.trim();

  const script = `
    cd ${shellEscape(cwd)}
    nohup sh -c ${escaped} > '${logFile}' 2>&1 &
    echo $!
  `;
  const res = await sandbox.exec(script);
  const pid = parseInt((res.stdout ?? "").trim(), 10) || null;

  const job = {
    jobId,
    command,
    cwd,
    pid,
    logFile,
    status: pid ? "running" : "unknown",
    startedAt: Date.now(),
  };
  session.jobs.push(job);
  return job;
}

// -------- Build MCP Server --------
function buildServer() {
  const server = new McpServer({
    name: "modal-mcp-server",
    version: "1.1.0",
  });

  const modal = getModalClient();

  // Outils existants
  server.tool(
    "modal_create_sandbox",
    "Crée un sandbox Modal isolé",
    { sessionId: z.string().optional().describe("Identifiant de session") },
    async ({ sessionId }) => {
      const sess = await sessionFromId(modal, sessionId || randomUUID());
      return {
        content: [
          {
            type: "text",
            text: `Sandbox créé / récupéré.\nSession: ${sess.id}\nSandbox ID: ${sess.sandbox.object_id || "n/a"}`,
          },
        ],
      };
    }
  );

  server.tool(
    "modal_list_sandboxes",
    "Liste les sandboxes Modal actifs (mémoire serveur)",
    {},
    async () => {
      const list = Array.from(sessions.values()).map((s) => ({
        sessionId: s.id,
        sandboxId: s.sandbox?.object_id,
        cwd: s.cwd,
        jobs: s.jobs.length,
        createdAt: s.createdAt,
        lastSeen: s.lastSeen,
      }));
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }
  );

  server.tool(
    "modal_terminate_sandbox",
    "Supprime un sandbox Modal",
    { sessionId: z.string().describe("Identifiant de session") },
    async ({ sessionId }) => {
      const sess = sessions.get(sessionId);
      if (!sess) return { content: [{ type: "text", text: "Session inconnue." }] };
      await sess.sandbox.terminate();
      sessions.delete(sessionId);
      return { content: [{ type: "text", text: `Session ${sessionId} terminée.` }] };
    }
  );

  server.tool(
    "modal_exec",
    "Exécute une commande one-shot dans un sandbox Modal",
    {
      sessionId: z.string().optional(),
      command: z.string(),
      cwd: z.string().optional(),
    },
    async ({ sessionId, command, cwd }) => {
      const sess = await sessionFromId(modal, sessionId || randomUUID());
      const res = await sess.sandbox.exec(command, cwd ? { cwd } : undefined);
      return {
        content: [{ type: "text", text: res.stdout || res.output || "" }],
        isError: (res.exit_code ?? res.exitCode ?? 0) !== 0,
      };
    }
  );

  // -------- NOUVEAU : Terminal persistant --------

  server.tool(
    "modal_terminal_run",
    "Crée/récupère un sandbox Modal et exécute une commande dans un shell persistant (cwd conservé)",
    {
      sessionId: z.string().optional().describe("Session persistante (défaut: généré)"),
      command: z.string().describe("Commande shell à exécuter"),
    },
    async ({ sessionId, command }) => {
      const id = sessionId || randomUUID();
      const sess = await sessionFromId(modal, id);
      const { output, cwd } = await sendCommand(sess.sandbox, command);
      sess.cwd = cwd;
      return {
        content: [{ type: "text", text: output }],
        metadata: { sessionId: id, cwd },
      };
    }
  );

  server.tool(
    "modal_terminal_continue",
    "Continue une session existante avec cwd conservé",
    {
      sessionId: z.string().describe("Session à reprendre"),
      command: z.string().describe("Commande shell"),
    },
    async ({ sessionId, command }) => {
      const sess = sessions.get(sessionId);
      if (!sess) {
        return { content: [{ type: "text", text: `Session ${sessionId} inexistante. Utilise modal_terminal_run.` }], isError: true };
      }
      const { output, cwd } = await sendCommand(sess.sandbox, command);
      sess.cwd = cwd;
      return { content: [{ type: "text", text: output }], metadata: { sessionId, cwd } };
    }
  );

  server.tool(
    "modal_terminal_status",
    "Statut de la session terminal",
    { sessionId: z.string().optional() },
    async ({ sessionId }) => {
      const sess = sessions.get(sessionId);
      if (!sess) return { content: [{ type: "text", text: "Aucune session active." }] };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: sess.id,
                sandboxId: sess.sandbox?.object_id,
                cwd: sess.cwd,
                jobs: sess.jobs.length,
                createdAt: new Date(sess.createdAt).toISOString(),
                lastSeen: new Date(sess.lastSeen).toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "modal_terminal_reset",
    "Termine et réinitialise la session",
    { sessionId: z.string() },
    async ({ sessionId }) => {
      const sess = sessions.get(sessionId);
      if (sess) {
        try { await sess.sandbox.exec(`cat ${FIFO_PID} | xargs kill -9 2>/dev/null`); } catch {}
        try { await sess.sandbox.terminate(); } catch {}
      }
      sessions.delete(sessionId);
      return { content: [{ type: "text", text: `Session ${sessionId} réinitialisée.` }] };
    }
  );

  server.tool(
    "modal_terminal_background",
    "Lance une commande longue en arrière-plan dans le sandbox",
    {
      sessionId: z.string().describe("Session à utiliser"),
      command: z.string(),
    },
    async ({ sessionId, command }) => {
      const sess = sessions.get(sessionId);
      if (!sess) return { content: [{ type: "text", text: `Session ${sessionId} inexistante.` }], isError: true };
      const job = await runInBackground(sess.sandbox, command, sess);
      return {
        content: [{ type: "text", text: `Job lancé : ${job.jobId}\nPID: ${job.pid || "n/a"}\nLog: ${job.logFile}` }],
        metadata: { job },
      };
    }
  );

  server.tool(
    "modal_terminal_jobs",
    "Liste les jobs de la session",
    { sessionId: z.string() },
    async ({ sessionId }) => {
      const sess = sessions.get(sessionId);
      if (!sess) return { content: [{ type: "text", text: "Session inexistante." }], isError: true };

      for (const job of sess.jobs) {
        if (job.status === "running" && job.pid) {
          const check = await sess.sandbox.exec(`kill -0 ${job.pid} 2>/dev/null && echo alive || echo dead`);
          job.status = check.stdout?.includes("alive") ? "running" : "completed";
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(sess.jobs, null, 2) }] };
    }
  );

  server.tool(
    "modal_terminal_attach",
    "Récupère les logs d’un job",
    {
      sessionId: z.string(),
      jobId: z.string(),
    },
    async ({ sessionId, jobId }) => {
      const sess = sessions.get(sessionId);
      if (!sess) return { content: [{ type: "text", text: "Session inexistante." }], isError: true };
      const job = sess.jobs.find((j) => j.jobId === jobId);
      if (!job) return { content: [{ type: "text", text: `Job ${jobId} inconnu.` }], isError: true };
      const res = await sess.sandbox.exec(`cat '${shellEscape(job.logFile)}' 2>/dev/null || echo '[log vide/inaccessible]'`);
      return { content: [{ type: "text", text: res.stdout ?? "" }] };
    }
  );

  server.tool(
    "modal_terminal_kill",
    "Envoie un signal à un job",
    {
      sessionId: z.string(),
      jobId: z.string(),
      signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).optional(),
    },
    async ({ sessionId, jobId, signal = "SIGTERM" }) => {
      const sess = sessions.get(sessionId);
      if (!sess) return { content: [{ type: "text", text: "Session inexistante." }], isError: true };
      const job = sess.jobs.find((j) => j.jobId === jobId);
      if (!job) return { content: [{ type: "text", text: `Job ${jobId} inconnu.` }], isError: true };
      if (!job.pid) return { content: [{ type: "text", text: "PID inconnu, impossible de tuer le job." }], isError: true };
      await sess.sandbox.exec(`kill -${signal.replace("SIG", "")} ${job.pid}`);
      job.status = "killed";
      return { content: [{ type: "text", text: `Signal ${signal} envoyé au job ${jobId}.` }] };
    }
  );

  return server;
}

// -------- HTTP endpoint MCP --------
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

app.get("/health", async (_req, res) => {
  res.json({ status: "ok", activeSessions: sessions.size, version: "1.1.0" });
});

app.listen(PORT, () => console.log(`modal-mcp-server (container) à l'écoute sur ${PORT}`));
