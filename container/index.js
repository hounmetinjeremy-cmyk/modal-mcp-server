// container/index.js
// Tourne dans un Cloudflare Container (Node.js complet, pas dans l'isolat V8
// des Workers classiques) — c'est ce qui permet d'utiliser le SDK Modal
// sans se heurter aux restrictions réseau/Node des Workers.

import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createRequire } from "module";
// Le package "modal" pose des soucis d'interop ESM/CJS selon l'environnement
// (ni export nommé ni export par défaut détectés de façon fiable). On force
// une résolution CommonJS avec createRequire, qui contourne ce problème.
const require = createRequire(import.meta.url);
const { ModalClient } = require("modal");

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());

// ---------- Identifiants Modal ----------
// Fournis en secrets Worker (wrangler secret put), transmis au conteneur
// via wrangler.jsonc / worker.js — voir README pour le détail.

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

// Sonde de santé utilisée par Cloudflare Containers pour savoir que le
// conteneur est prêt à recevoir du trafic.
app.get("/health", (req, res) => res.status(200).send("ok"));

const openSandboxes = new Map(); // id -> Sandbox

function buildServer() {
  const server = new McpServer({ name: "modal-mcp-server", version: "1.0.0" });

  server.registerTool(
    "modal_create_sandbox",
    {
      title: "Créer un sandbox Modal",
      description:
        "Crée un sandbox Modal isolé pour cloner et traiter un projet. Retourne un sandbox_id à réutiliser dans les autres outils.",
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
          text: `Sandbox créé. sandbox_id=${id} (image: ${image}, ${cpu} vCPU, ${memoryMb} Mo RAM, expire dans ${timeoutSeconds}s)`,
        }],
      };
    }
  );

  server.registerTool(
    "modal_exec",
    {
      title: "Exécuter une commande dans un sandbox",
      description:
        "Exécute une commande shell dans un sandbox Modal déjà créé (clone git, install, build, push...).",
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
      title: "Arrêter un sandbox",
      description: "Arrête et nettoie un sandbox Modal.",
      inputSchema: { sandboxId: z.string() },
    },
    async ({ sandboxId }) => {
      const sandbox = openSandboxes.get(sandboxId);
      if (!sandbox) {
        return { content: [{ type: "text", text: `Sandbox inconnu: ${sandboxId}` }], isError: true };
      }
      await sandbox.terminate();
      openSandboxes.delete(sandboxId);
      return { content: [{ type: "text", text: `Sandbox ${sandboxId} arrêté.` }] };
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

app.listen(PORT, () => console.log(`modal-mcp-server (container) écoute sur ${PORT}`));
