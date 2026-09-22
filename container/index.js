// container/index.js
// Tourne dans un Cloudflare Container (Node.js complet, pas dans l'isolat V8
// des Workers classiques) -- c'est ce qui permet d'utiliser le SDK Modal
// sans se heurter aux restrictions reseau/Node des Workers.

import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ModalClient } from "modal";

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());

function getModalClient() {
  const tokenId = process.env.MODAL_TOKEN_ID;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    throw new Error(
      "MODAL_TOKEN_ID / MODAL_TOKEN_SECRET manquants. Configure-les avec " +
      "`wrangler secret put` puis redeploie."
    );
  }
  return new ModalClient({ tokenId, tokenSecret });
}

app.get("/", (req, res) => res.send("modal-mcp-server: OK"));
app.get("/health", (req, res) => res.status(200).send("ok"));

const openSandboxes = new Map();

function buildServer() {
  const server = new McpServer({ name: "modal-mcp-server", version: "1.0.0" });

  server.registerTool(
    "modal_create_sandbox",
    {
      title: "Creer un sandbox Modal",
      description:
        "Cree un sandbox Modal isole pour cloner et traiter un projet. Retourne un sandbox_id a reutiliser dans les autres outils.",
      inputSchema: {
        image: z.string().default("python:3.12-slim"),
        appName: z.string().default("chap-libre"),
        cpu: z.number().default(1),
        memoryMb: z.number().default(1024),
        timeoutSeconds: z.number().default(600),
      },
    },
    async ({ image, appName, cpu, memoryMb, timeoutSeconds }) => {
      const modal = getModalClient();
      const modalApp = await modal.apps.fromName(appName, { createIfMissing: true });
      const img = modal.images.fromRegistry(image);
      const sandbox = await modal.sandboxes.create(modalApp, img, {
        cpu,
        memory: memoryMb,
        timeout: timeoutSeconds,
      });
      const id = randomUUID();
      openSandboxes.set(id, sandbox);
      return {
        content: [{
          type: "text",
          text: `Sandbox cree. sandbox_id=${id} (image: ${image}, ${cpu} vCPU, ${memoryMb} Mo RAM, expire dans ${timeoutSeconds}s)`,
        }],
      };
    }
  );

  server.registerTool(
    "modal_exec",
    {
      title: "Executer une commande dans un sandbox",
      description:
        "Execute une commande shell dans un sandbox Modal deja cree (clone git, install, build, push...).",
      inputSchema: {
        sandboxId: z.string(),
        command: z.array(z.string()),
      },
    },
    async ({ sandboxId, command }) => {
      const sandbox = openSandboxes.get(sandboxId);
      if (!sandbox) {
        return { content: [{ type: "text", text: `Sandbox inconnu: ${sandboxId}` }], isError: true };
      }
      const proc = await sandbox.exec(command);
      const stdout = await proc.stdout.readText();
      const stderr = await proc.stderr.readText();
      const exitCode = await proc.wait();
      return {
        content: [{
          type: "text",
          text: `exit_code=${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        }],
      };
    }
  );

  server.registerTool(
    "modal_terminate_sandbox",
    {
      title: "Arreter un sandbox",
      description: "Arrete et nettoie un sandbox Modal.",
      inputSchema: { sandboxId: z.string() },
    },
    async ({ sandboxId }) => {
      const sandbox = openSandboxes.get(sandboxId);
      if (!sandbox) {
        return { content: [{ type: "text", text: `Sandbox inconnu: ${sandboxId}` }], isError: true };
      }
      await sandbox.terminate();
      openSandboxes.delete(sandboxId);
      return { content: [{ type: "text", text: `Sandbox ${sandboxId} arrete.` }] };
    }
  );

  server.registerTool(
    "modal_list_sandboxes",
    {
      title: "Lister les sandboxes ouverts",
      description: "Liste les sandboxes actuellement suivis par ce conteneur.",
      inputSchema: {},
    },
    async () => {
      const ids = [...openSandboxes.keys()];
      return {
        content: [{
          type: "text",
          text: ids.length ? `Sandboxes ouverts: ${ids.join(", ")}` : "Aucun sandbox ouvert.",
        }],
      };
    }
  );

  return server;
}

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

app.listen(PORT, () => console.log(`modal-mcp-server (container) ecoute sur ${PORT}`));
