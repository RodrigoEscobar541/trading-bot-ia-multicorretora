// ttMarketData.js — dados de MERCADO da Tastytrade: cotações por REST e
// candles pelo streamer DXLink (dxfeed).
//
// Submódulo do conector TT (src/conectores/tt/conectorTT.js).
//
//   - Cotações (preço atual / vários símbolos): GET /market-data/by-type —
//     snapshot REST simples, até 100 símbolos por chamada (base do
//     patrimônio da plataforma em UMA requisição, como /tickers no MB).
//   - Candles: a API não tem histórico por REST — vêm do WebSocket DXLink:
//     GET /api-quote-tokens dá um token (~24h) + a URL do streamer; o
//     protocolo é JSON (SETUP → AUTH → CHANNEL_REQUEST/FEED → FEED_SETUP →
//     FEED_SUBSCRIPTION com fromTime) e o servidor devolve o histórico como
//     eventos Candle. A conexão é EFÊMERA: abre, coleta, fecha — quem chama
//     (cicloAtivo) continua puxando `candles(par, res, n)` sem saber disso.
//
// Requer WebSocket global (Node >= 22). Nos testes, a implementação é
// injetável (parâmetro WebSocketImpl).

import { ErroTT, requisitar } from './ttHttp.js';
import { autenticar } from './ttAuth.js';
import { registrarSegredo } from '../../utils/logger.js';

const n = (v) => {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
};

// ------------------------------------------------------------- cotações REST

const normalizarCotacao = (c) => ({
  simbolo: c.symbol,
  ultimo: n(c.last ?? c.mark ?? c.mid),
  compra: n(c.bid),
  venda: n(c.ask),
  maxima: n(c['day-high-price'] ?? c['day-high'] ?? c.last),
  minima: n(c['day-low-price'] ?? c['day-low'] ?? c.last),
  volume: n(c.volume),
  horario: c['updated-at'] ?? new Date().toISOString(),
});

/**
 * Cotações de VÁRIOS símbolos de ações em uma chamada:
 * devolve { 'AAPL': cotacao, ... }. Símbolos sem cotação ficam de fora.
 */
export async function obterCotacoes(credenciais, simbolos) {
  if (!Array.isArray(simbolos) || simbolos.length === 0) return {};
  const token = await autenticar(credenciais);
  const dados = await requisitar('GET', '/market-data/by-type', {
    token,
    ambiente: credenciais.ambiente,
    params: { equity: simbolos },
  });
  const mapa = {};
  for (const c of dados?.items ?? []) {
    if (c?.symbol) mapa[c.symbol] = normalizarCotacao(c);
  }
  return mapa;
}

/** Cotação de UM símbolo (preço atual + resumo do dia). */
export async function obterCotacao(credenciais, simbolo) {
  const mapa = await obterCotacoes(credenciais, [simbolo]);
  const cotacao = mapa[simbolo];
  if (!cotacao || !cotacao.ultimo) {
    throw new ErroTT(`cotação ausente para ${simbolo}`, { endpoint: '/market-data/by-type' });
  }
  return cotacao;
}

// -------------------------------------------------------- candles via DXLink

// Token de cotações do streamer. A API o documenta como válido por ~24h, e era
// isso que este cache guardava — mas o token nasce DENTRO da sessão OAuth que o
// pediu, e a sessão desta integração dura ~15 min (ttAuth.js). Guardá-lo por 23h
// significava usar, por quase um dia, um token cuja sessão morreu no primeiro
// quarto de hora: o streamer respondia `ERROR UNAUTHORIZED Authentication
// failed`, nada invalidava o cache, e TODA análise de TODO ativo da TT falhava
// até o TTL vencer. Foi o que aconteceu em 14/08/2026 — TT/PBR e TT/SPCX
// alternando erro a tarde inteira, sempre com o mesmo token morto.
//
// Agora o cache é ancorado no ACCESS TOKEN que o gerou: sessão renovada,
// token de cotação novo. As 23h continuam como teto secundário.
const tokensDeCotacao = new Map(); // refreshToken → { token, url, expiraEmMs, accessToken }
const VIDA_TOKEN_COTACAO_MS = 23 * 60 * 60 * 1000;

/**
 * Token + URL do streamer. `forcar` ignora o cache — é o caminho da segunda
 * tentativa, depois de o streamer ter recusado o token anterior.
 *
 * `autenticar` é chamado SEMPRE, de propósito: ele tem cache próprio (~15 min),
 * então não custa rede, e é a única forma de saber se a sessão ainda é a mesma
 * que gerou o token guardado.
 */
async function obterTokenDeCotacao(credenciais, { forcar = false } = {}) {
  const accessToken = await autenticar(credenciais);
  const cache = tokensDeCotacao.get(credenciais.refreshToken);
  if (!forcar && cache && cache.accessToken === accessToken && Date.now() < cache.expiraEmMs) return cache;

  const dados = await requisitar('GET', '/api-quote-tokens', { token: accessToken, ambiente: credenciais.ambiente });
  if (!dados?.token || !dados?.['dxlink-url']) {
    throw new ErroTT('resposta de /api-quote-tokens em formato inesperado', { endpoint: '/api-quote-tokens' });
  }
  registrarSegredo(dados.token);
  const entrada = {
    token: dados.token,
    url: dados['dxlink-url'],
    expiraEmMs: Date.now() + VIDA_TOKEN_COTACAO_MS,
    accessToken,
  };
  tokensDeCotacao.set(credenciais.refreshToken, entrada);
  return entrada;
}

// Resoluções do contrato dos conectores → período de candle do dxfeed.
const RESOLUCOES = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': 'h', '1d': 'd', '1w': 'w', '1M': 'mo',
};
const RESOLUCAO_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '1d': 86_400_000, '1w': 604_800_000, '1M': 2_592_000_000,
};

// Campos pedidos ao streamer para eventos Candle (formato COMPACT).
const CAMPOS_CANDLE = ['eventSymbol', 'time', 'open', 'high', 'low', 'close', 'volume'];

/**
 * Converte blocos FEED_DATA (formato COMPACT) em candles do contrato.
 * `dados` é o array ['Candle', [v1, v2, ...]] com os valores achatados na
 * ordem de `campos`. Pura — testável sem WebSocket.
 */
export function converterFeedData(dados, campos = CAMPOS_CANDLE) {
  if (!Array.isArray(dados) || dados[0] !== 'Candle' || !Array.isArray(dados[1])) return [];
  const plano = dados[1];
  const candles = [];
  for (let i = 0; i + campos.length <= plano.length; i += campos.length) {
    const c = {};
    campos.forEach((campo, j) => { c[campo] = plano[i + j]; });
    if (!Number.isFinite(Number(c.time))) continue;
    candles.push({
      horario: new Date(Number(c.time)).toISOString(),
      abertura: n(c.open),
      maxima: n(c.high),
      minima: n(c.low),
      fechamento: n(c.close),
      volume: n(c.volume),
    });
  }
  return candles;
}

/**
 * Coleta candles históricos numa conexão DXLink efêmera. Resolve quando a
 * coleta "aquieta" (sem dados novos por `quietudeMs`) ou no timeout — o que
 * chegou até lá é devolvido; quem chama valida a quantidade.
 */
export function coletarCandlesDXLink({
  url,
  token,
  simboloCandle,
  deMs,
  timeoutMs = 15_000,
  quietudeMs = 800,
  WebSocketImpl = globalThis.WebSocket,
}) {
  if (typeof WebSocketImpl !== 'function') {
    throw new ErroTT('WebSocket indisponível — o bot requer Node >= 22 para os candles da Tastytrade');
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const candles = [];
    let camposServidor = CAMPOS_CANDLE;
    let quietude = null;
    let terminado = false;
    let autenticacaoEnviada = false;

    const terminar = (erro = null) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(prazo);
      clearTimeout(quietude);
      try { ws.close(); } catch { /* já fechado */ }
      if (erro) reject(erro);
      else resolve(candles);
    };
    const prazo = setTimeout(() => terminar(candles.length > 0 ? null : new ErroTT('timeout aguardando candles do DXLink')), timeoutMs);
    const enviar = (msg) => ws.send(JSON.stringify(msg));
    const agendarQuietude = () => {
      clearTimeout(quietude);
      quietude = setTimeout(() => terminar(), quietudeMs);
    };

    ws.addEventListener('error', () => terminar(new ErroTT('falha na conexão com o streamer DXLink')));
    ws.addEventListener('open', () => {
      enviar({ type: 'SETUP', channel: 0, version: '0.1-js/1.0.0', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case 'AUTH_STATE':
          // UNAUTHORIZED é o estado NORMAL logo após o SETUP: é o convite para
          // mandar o token. Mas se ele volta DEPOIS de já termos autenticado, o
          // token foi recusado — e reenviá-lo faria o mesmo par de mensagens em
          // laço até o timeout de 15 s, escondendo uma falha de credencial atrás
          // de um "timeout aguardando candles".
          if (msg.state === 'UNAUTHORIZED') {
            if (autenticacaoEnviada) {
              terminar(new ErroTT('streamer DXLink recusou o token de cotação', { autenticacao: true }));
              break;
            }
            autenticacaoEnviada = true;
            enviar({ type: 'AUTH', channel: 0, token });
          } else if (msg.state === 'AUTHORIZED') {
            enviar({ type: 'CHANNEL_REQUEST', channel: 1, service: 'FEED', parameters: { contract: 'AUTO' } });
          }
          break;
        case 'CHANNEL_OPENED':
          enviar({
            type: 'FEED_SETUP',
            channel: 1,
            acceptAggregationPeriod: 10,
            acceptDataFormat: 'COMPACT',
            acceptEventFields: { Candle: CAMPOS_CANDLE },
          });
          break;
        case 'FEED_CONFIG':
          // O servidor confirma os campos que VAI usar — parseia por eles.
          if (Array.isArray(msg.eventFields?.Candle)) camposServidor = msg.eventFields.Candle;
          enviar({
            type: 'FEED_SUBSCRIPTION',
            channel: 1,
            add: [{ type: 'Candle', symbol: simboloCandle, fromTime: deMs }],
          });
          agendarQuietude();
          break;
        case 'FEED_DATA':
          candles.push(...converterFeedData(msg.data, camposServidor));
          agendarQuietude();
          break;
        case 'ERROR':
          terminar(
            new ErroTT(`streamer DXLink recusou: ${msg.error ?? ''} ${msg.message ?? ''}`.trim(), {
              // Só o UNAUTHORIZED é recuperável trocando o token; qualquer outro
              // erro do streamer (símbolo inválido, canal, protocolo) seguiria
              // falhando igual com um token novo — repetir seria só gastar rede.
              autenticacao: String(msg.error ?? '').toUpperCase() === 'UNAUTHORIZED',
            }),
          );
          break;
        default:
          break; // SETUP/KEEPALIVE/CHANNEL_* não exigem ação numa conexão curta
      }
    });
  });
}

/**
 * Candles OHLCV do símbolo, do mais antigo para o mais recente — mesma
 * assinatura dos demais conectores. Para ações, o histórico só anda no
 * pregão: o `fromTime` recua alguns dias-calendário a mais para cobrir
 * noites, fins de semana e feriados, e o resultado é cortado nos últimos N.
 */
export async function obterCandles(credenciais, simbolo, resolucao = '15m', quantidade = 100, opcoes = {}) {
  const periodo = RESOLUCOES[resolucao];
  if (!periodo) throw new ErroTT(`resolução de candle não suportada: ${resolucao}`);

  const janelaMs = RESOLUCAO_MS[resolucao] * quantidade;
  const deMs = Date.now() - janelaMs * 5; // folga p/ noites/fins de semana/feriados

  // Uma tentativa; se o streamer RECUSAR o token, uma segunda com token novo.
  // A segunda existe porque o token pode morrer entre ser pedido e ser usado
  // (sessão renovada por outro ativo no meio do caminho), e porque nenhuma
  // âncora de cache cobre o caso de a corretora invalidar o token do seu lado.
  // Só isso: um terceiro laço viraria martelo numa credencial de fato inválida.
  let brutos;
  for (let tentativa = 0; ; tentativa++) {
    const { token, url } = await obterTokenDeCotacao(credenciais, { forcar: tentativa > 0 });
    try {
      brutos = await coletarCandlesDXLink({
        url,
        token,
        simboloCandle: `${simbolo}{=${periodo}}`,
        deMs,
        ...opcoes,
      });
      break;
    } catch (e) {
      if (!e?.autenticacao || tentativa > 0) throw e;
      // Token queimado: fora do cache, para o próximo ativo não repetir o erro.
      tokensDeCotacao.delete(credenciais.refreshToken);
    }
  }

  // Dedupe por horário (o streamer pode reenviar a vela corrente) + ordenação.
  const porHorario = new Map();
  for (const c of brutos) porHorario.set(c.horario, c);
  const ordenados = [...porHorario.values()].sort((a, b) => a.horario.localeCompare(b.horario));
  const finais = ordenados.slice(-quantidade);
  if (finais.length === 0) {
    throw new ErroTT(`candles ausentes para ${simbolo} (${resolucao})`, { endpoint: 'dxlink' });
  }
  return finais;
}

/** Limpa caches (testes). */
export function limparCachesMarketData() {
  tokensDeCotacao.clear();
}
