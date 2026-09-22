# Serveur MCP Modal — sur Cloudflare Containers

Contrairement à un Worker classique (isolat V8 restreint), **Cloudflare
Containers** fait tourner un vrai conteneur Docker Node.js complet — c'est
ce qui permet d'utiliser le SDK Modal sans problème de compatibilité
réseau/gRPC.

## Prérequis

- **Plan Workers Paid** (~5$/mois) — Containers ne fonctionne pas sur le
  plan gratuit. Si tu as déjà des Workers payants pour tes autres projets
  (Oracle Cloud MCP, Railway MCP, center-multivendor), tu es peut-être déjà
  dessus — vérifie dans le dashboard Cloudflare (Workers & Pages →
  Plans).
- Docker installé localement (pour builder l'image).
- Wrangler CLI v4+ : `npm install -g wrangler@latest`

## Structure du projet

```
modal-mcp-server/
├── wrangler.jsonc       # config Worker + Container
├── worker.js            # routeur : Worker -> Container
└── container/
    ├── Dockerfile
    ├── package.json
    └── index.js         # le vrai serveur MCP (Express + SDK Modal)
```

## Déploiement

```bash
git clone https://github.com/hounmetinjeremy-cmyk/modal-mcp-server.git
cd modal-mcp-server
wrangler login

# Génère ta clé sur https://modal.com/settings/tokens ("New Token")
wrangler secret put MODAL_TOKEN_ID
wrangler secret put MODAL_TOKEN_SECRET

wrangler deploy
```

Wrangler build l'image Docker à partir de `container/Dockerfile` et la
déploie automatiquement — pas besoin de push manuel vers un registre.

## ⚠️ Point à vérifier après déploiement

Le passage des secrets Worker (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`) vers
l'intérieur du conteneur, dans `worker.js`, est écrit selon la doc connue
au moment de l'écriture, mais l'API `@cloudflare/containers` évolue vite.
Si le conteneur démarre mais que les outils Modal échouent avec "token
manquant", vérifie la syntaxe exacte de passage des env vars sur
https://developers.cloudflare.com/containers/ — la doc à jour fait
autorité ici, pas ce fichier.

## Connecter à Claude / chap-libre

Une fois déployé, Wrangler affiche l'URL publique du Worker, du type :
`https://modal-mcp-server.<ton-compte>.workers.dev`

URL du serveur MCP à ajouter : `https://modal-mcp-server.<ton-compte>.workers.dev/mcp`

## Outils exposés

- `modal_create_sandbox` — crée un sandbox isolé
- `modal_exec` — exécute une commande shell dedans (clone, install, build, push...)
- `modal_terminate_sandbox` — l'arrête
- `modal_list_sandboxes` — liste les sandboxes ouverts

## Coût

- Workers Paid : ~5$/mois (fixe)
- Container : facturé à la seconde d'usage réel (`sleepAfter: "10m"` coupe
  le conteneur après 10 min d'inactivité)
- Modal : crédit de 30$/mois qui se renouvelle, consommé par les sandboxes eux-mêmes
