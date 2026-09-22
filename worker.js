// worker.js
// Point d'entree Worker : recoit les requetes HTTP publiques et les
// transmet au conteneur (qui, lui, fait tourner le vrai serveur Node/Express
// avec le SDK Modal).

import { Container, getContainer } from "@cloudflare/containers";

export class ModalMcpContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m"; // le conteneur s'eteint apres 10 min d'inactivite (facturation a l'usage)

  // Transmet les secrets definis avec `wrangler secret put` au conteneur.
  // A verifier contre la doc a jour (developers.cloudflare.com/containers) --
  // l'API exacte de passage des variables d'environnement peut avoir evolue.
  envVars = {
    MODAL_TOKEN_ID: this.env?.MODAL_TOKEN_ID,
    MODAL_TOKEN_SECRET: this.env?.MODAL_TOKEN_SECRET,
  };
}

export default {
  async fetch(request, env) {
    const container = getContainer(env.MODAL_MCP_CONTAINER);
    return container.fetch(request);
  },
};
