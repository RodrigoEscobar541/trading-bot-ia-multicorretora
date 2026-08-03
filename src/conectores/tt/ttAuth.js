// ttAuth.js — autenticação OAuth2 da Tastytrade (obrigatória desde 2025-12).
//
// Fluxo de uso pessoal (sem servidor de redirect): o dono cria uma OAuth
// Application em my.tastytrade.com (client id + client secret) e um
// "Personal OAuth Grant", que gera um REFRESH TOKEN que não expira. Em
// runtime, este módulo troca o refresh token por um ACCESS TOKEN de ~15
// minutos (POST /oauth/token) e o cacheia com margem de renovação — o mesmo
// padrão do Bearer cacheado do mbPrivado.js.
//
// Credenciais esperadas (doc `plataformas/TT/dados/api` ou .env em dev):
//   tt_client_secret, tt_refresh_token (obrigatórios)
//   tt_account_id (opcional — vazio usa a primeira conta do cliente)
//   tt_ambiente   (opcional — 'cert' aponta para o sandbox)

import { ErroTT, requisitar } from './ttHttp.js';
import { registrarSegredo } from '../../utils/logger.js';

const MARGEM_RENOVACAO_MS = 60_000;
const VIDA_PADRAO_S = 900; // a API informa expires_in (~15 min); fallback

// Cache do access token por refresh token — renovado quando perto de expirar.
const tokens = new Map(); // refreshToken → { accessToken, expiraEmMs }

/** Autentica (ou reaproveita o access token válido) e o devolve. */
export async function autenticar(credenciais) {
  const { clientSecret, refreshToken, ambiente } = credenciais ?? {};
  if (!clientSecret || !refreshToken) {
    throw new ErroTT('credenciais da Tastytrade ausentes — configure tt_client_secret/tt_refresh_token');
  }
  registrarSegredo(clientSecret);
  registrarSegredo(refreshToken);

  const cache = tokens.get(refreshToken);
  if (cache && Date.now() < cache.expiraEmMs - MARGEM_RENOVACAO_MS) {
    return cache.accessToken;
  }

  const dados = await requisitar('POST', '/oauth/token', {
    ambiente,
    corpo: {
      grant_type: 'refresh_token',
      client_secret: clientSecret,
      refresh_token: refreshToken,
    },
  });
  if (!dados?.access_token) {
    throw new ErroTT('autenticação na Tastytrade não devolveu access_token', { endpoint: '/oauth/token' });
  }
  registrarSegredo(dados.access_token);
  tokens.set(refreshToken, {
    accessToken: dados.access_token,
    expiraEmMs: Date.now() + Number(dados.expires_in ?? VIDA_PADRAO_S) * 1000,
  });
  return dados.access_token;
}

/** Limpa o cache (testes). */
export function limparCacheDeTokens() {
  tokens.clear();
}
