// ttHttp.js — base HTTP da API da Tastytrade (Open API).
//
// Submódulo do conector TT (src/conectores/tt/conectorTT.js). Concentra a
// requisição bruta: URLs base (produção e sandbox/cert), User-Agent
// obrigatório (a API bloqueia requisições sem ele), serialização de query
// (inclusive parâmetros repetidos, ex.: instrument-collections[]) e o erro
// tipado ErroTT. Nenhum arquivo fora de src/conectores/tt/ pode chamar a API
// da Tastytrade diretamente.
//
// A API usa JSON com chaves em kebab-case (ex.: 'cash-balance') e envelopa a
// resposta em { data: ... } — quem chama lê `resposta.data`.

const URLS_BASE = {
  producao: 'https://api.tastyworks.com',
  cert: 'https://api.cert.tastyworks.com', // sandbox: reset diário, cotações 15 min atrasadas
};
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'ia-investidora/2.2';

export class ErroTT extends Error {
  constructor(mensagem, { status = null, endpoint = null, autenticacao = false } = {}) {
    super(mensagem);
    this.name = 'ErroTT';
    this.status = status;
    this.endpoint = endpoint;
    // A credencial foi RECUSADA (não é falha de rede nem de formato). Quem
    // chama usa isto para descartar o token cacheado e tentar de novo com um
    // novo — ver `obterCandles` em ttMarketData.js.
    this.autenticacao = autenticacao;
  }
}

/** URL base do ambiente ('producao' padrão; 'cert' para o sandbox). */
export function urlBase(ambiente) {
  return URLS_BASE[ambiente] ?? URLS_BASE.producao;
}

/**
 * Requisição à API da Tastytrade. `params` aceita valores escalares ou arrays
 * (arrays viram parâmetros repetidos, como a API espera). Devolve o JSON já
 * desembrulhado de { data } quando presente.
 */
export async function requisitar(metodo, caminho, { corpo = null, token = null, params = {}, ambiente } = {}) {
  const url = new URL(`${urlBase(ambiente)}${caminho}`);
  for (const [chave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null) continue;
    for (const v of Array.isArray(valor) ? valor : [valor]) url.searchParams.append(chave, v);
  }

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let resposta;
  try {
    resposta = await fetch(url, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ErroTT(`falha de rede em ${metodo} ${caminho}: ${e.message}`, { endpoint: caminho });
  }

  if (!resposta.ok) {
    let detalhe = '';
    try {
      const erro = await resposta.json();
      detalhe = erro?.error?.message ?? erro?.error?.code ?? '';
    } catch {
      /* corpo não-JSON: segue sem detalhe */
    }
    throw new ErroTT(
      `Tastytrade respondeu HTTP ${resposta.status} em ${metodo} ${caminho}${detalhe ? ` (${detalhe})` : ''}`,
      { status: resposta.status, endpoint: caminho },
    );
  }
  if (resposta.status === 204) return null;
  const json = await resposta.json();
  return json?.data ?? json;
}
