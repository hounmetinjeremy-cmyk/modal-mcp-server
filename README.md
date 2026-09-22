# Serveur MCP Modal + Terminal Persistant

Serveur MCP hébergé sur **Cloudflare Containers** (sandbox isolée V8), qui pilote des
sandboxes **Modal** et expose un **terminal shell persistant**.

## Outils MCP exposés

### Terminal persistant
- `modal_terminal_run` — crée/récupère un sandbox Modal et exécute une commande
- `modal_terminal_continue` — continue la même session avec `cwd` conservé
- `modal_terminal_status` — sandbox, cwd, jobs et dernière activité
- `modal_terminal_reset` — détruit le sandbox et réinitialise la session
- `modal_terminal_background` — lance un job long en arrière-plan
- `modal_terminal_jobs` — liste les jobs
- `modal_terminal_attach` — récupère les logs d’un job
- `modal_terminal_kill` — envoie SIGTERM/SIGKILL/SIGINT à un job

### Gestion Modal classique
- `modal_create_sandbox`, `modal_list_sandboxes`, `modal_terminate_sandbox`
- `modal_exec` — exécution one-shot dans un sandbox

## Architecture du terminal

1. Au premier `modal_terminal_run`, le serveur crée un **sandbox Modal**.
2. Il y démarre un **daemon `bash` persistant** connecté à deux FIFOs :
   - `/tmp/mcp_terminal_cmd` : entrée des commandes
   - `/tmp/mcp_terminal_out` : sortie des commandes
3. Après chaque commande, le `cwd` est sauvegardé dans `/tmp/mcp_cwd`.
4. Les jobs en arrière-plan utilisent `nohup` et écrivent dans `/tmp/mcp_jobs/<jobId>.log`.

## Déploiement

```bash
git clone https://github.com/hounmetinjeremy-cmyk/modal-mcp-server.git
cd modal-mcp-server
git checkout feature/terminal-persistant
wrangler login

# Secrets Modal (https://modal.com/settings/tokens)
wrangler secret put MODAL_TOKEN_ID
wrangler secret put MODAL_TOKEN_SECRET

wrangler deploy
```

## Configuration client MCP

```json
{
  "mcpServers": {
    "ko": {
      "url": "https://modal-mcp-server.<ton-compte>.workers.dev/mcp"
    }
  }
}
```

## Exemple d’utilisation

```
modal_terminal_run sessionId="dev-1" command="cd /tmp && pwd"
modal_terminal_continue sessionId="dev-1" command="ls -la"
modal_terminal_background sessionId="dev-1" command="for i in $(seq 1 10); do echo tick $i; sleep 2; done"
modal_terminal_attach sessionId="dev-1" jobId="job_..."
modal_terminal_kill sessionId="dev-1" jobId="job_..." signal="SIGKILL"
modal_terminal_reset sessionId="dev-1"
```
