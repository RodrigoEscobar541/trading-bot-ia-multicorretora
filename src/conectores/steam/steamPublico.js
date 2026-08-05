// steamPublico.js — dados públicos do Mercado da Comunidade Steam (ROADMAP
// prioridade 4, fase 1). Submódulo do conector STEAM: preço de item e
// inventário do dono.
//
// Nenhum destes endpoints é oficial nem documentado pela Valve — são os mesmos
// que a própria página do mercado usa —, e NENHUM deles pede login: só leitura
// pública. Deliberadamente não usamos `/market/pricehistory/`, o único que
// exigiria o cookie de sessão do dono: colocar cookie de conta num robô é
// arriscar a conta dele por um dado que o próprio bot pode acumular com o
// tempo.
//
// LIMITE DE REQUISIÇÃO: o steamcommunity.com corta por ~1 min quem passa de
// ~20 chamadas/min, e o preço é UMA chamada por item (não existe lote). Quem
// chama controla o ritmo — daí `pausaMs` em obterPrecos().
//
// Este módulo apenas lança erros tipados (ErroSteam); quem chama decide como
// logar/pular a iteração, para nunca derrubar o loop principal (CLAUDE.md §3).

const BASE_COMUNIDADE = 'https://steamcommunity.com';
// API Web OFICIAL da Valve (a única coisa oficial neste conector). O endpoint
// de notícias não pede chave.
const BASE_API = 'https://api.steampowered.com';
const BASE_IMAGEM = 'https://community.cloudflare.steamstatic.com/economy/image';
const TIMEOUT_MS = 15_000;

// CS2. O `contextid` 2 é o inventário de itens do jogo (o único que interessa).
export const APPID_CS2 = 730;
export const CONTEXTID_ITENS = 2;

// Moeda do mercado no formato da Steam (o parâmetro `currency`): 7 = BRL.
export const MOEDA_BRL = 7;

// User-Agent explícito: a Steam responde 403 a alguns clientes sem ele.
const USER_AGENT = 'ia-investidora/1.0 (bot de análise, somente leitura)';

export class ErroSteam extends Error {
  constructor(mensagem, { status = null, endpoint = null } = {}) {
    super(mensagem);
    this.name = 'ErroSteam';
    this.status = status;
    this.endpoint = endpoint;
    // Sinaliza o corte por excesso de requisições: quem chama pode desacelerar
    // em vez de tratar como item inexistente.
    this.limiteExcedido = status === 429;
  }
}

async function requisitar(base, caminho, params = {}) {
  const url = new URL(`${base}${caminho}`);
  for (const [chave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null) url.searchParams.set(chave, valor);
  }

  let resposta;
  try {
    resposta = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ErroSteam(`falha de rede ao chamar ${caminho}: ${e.message}`, { endpoint: caminho });
  }
  if (!resposta.ok) {
    throw new ErroSteam(`Steam respondeu HTTP ${resposta.status} em ${caminho}`, {
      status: resposta.status,
      endpoint: caminho,
    });
  }
  try {
    return await resposta.json();
  } catch {
    throw new ErroSteam(`resposta não-JSON em ${caminho}`, { endpoint: caminho });
  }
}

// ------------------------------------------------------------------- números
//
// A Steam devolve dinheiro já FORMATADO na moeda pedida ("R$ 1.234,56",
// "$1,234.56") e quantidade com separador de milhar ("1,234"). Não há campo
// numérico: ou se interpreta o texto, ou não há preço.

/**
 * Dinheiro formatado pela Steam → número. Resolve o ponto×vírgula pela REGRA
 * DA ÚLTIMA OCORRÊNCIA: o separador que aparece por último é o decimal
 * ("1.234,56" → 1234.56; "1,234.56" → 1234.56). Separador único seguido de
 * exatamente 3 dígitos é milhar ("1,234" → 1234). Devolve null se não houver
 * número reconhecível — nunca 0, que seria confundido com "de graça".
 */
export function precoParaNumero(texto) {
  if (typeof texto === 'number') return Number.isFinite(texto) ? texto : null;
  if (typeof texto !== 'string') return null;

  // Fora tudo que não for dígito ou separador (símbolo de moeda, espaço fino,
  // espaço não-quebrável que a Steam usa em algumas moedas).
  const limpo = texto.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(limpo)) return null;

  const ultimaVirgula = limpo.lastIndexOf(',');
  const ultimoPonto = limpo.lastIndexOf('.');
  let decimal = null;
  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    decimal = ultimaVirgula > ultimoPonto ? ',' : '.';
  } else if (ultimaVirgula >= 0 || ultimoPonto >= 0) {
    const sep = ultimaVirgula >= 0 ? ',' : '.';
    const depois = limpo.length - limpo.lastIndexOf(sep) - 1;
    // 3 casas depois do separador único = milhar ("1,234"); o resto é decimal.
    decimal = depois === 3 ? null : sep;
  }

  let normalizado;
  if (decimal === null) {
    normalizado = limpo.replace(/[.,]/g, '');
  } else {
    const outro = decimal === ',' ? '.' : ',';
    normalizado = limpo.split(outro).join('').replace(decimal, '.');
  }

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/** Quantidade formatada ("1,234") → inteiro. Separadores são só de milhar. */
export function quantidadeParaNumero(texto) {
  if (typeof texto === 'number') return Number.isFinite(texto) ? Math.trunc(texto) : 0;
  if (typeof texto !== 'string') return 0;
  const n = Number(texto.replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// --------------------------------------------------------------------- itens

/**
 * `market_hash_name` → id de documento do Firestore. O nome real tem `|`,
 * espaços, parênteses e às vezes `/` ("AK-47 | Redline (Field-Tested)",
 * "Sticker | Team | Katowice 2014"), e `/` quebraria o caminho do documento.
 * O nome EXATO continua no `par` do manifest — é ele que vai para a API; este
 * slug serve só para endereçar o documento.
 */
export function slugDoItem(marketHashName) {
  return String(marketHashName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // acentos
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) // teto de id do Firestore com folga
    .toUpperCase() || 'ITEM';
}

/**
 * URL da imagem do item a partir do `icon_url` que o inventário devolve.
 * A imagem vem do CDN da Steam — nada é hospedado por nós, só o `icon_url`
 * fica guardado.
 */
export function urlDaImagem(iconUrl, tamanho = '128fx128f') {
  if (!iconUrl) return null;
  return `${BASE_IMAGEM}/${iconUrl}/${tamanho}`;
}

// --------------------------------------------------------------------- preço

/**
 * Preço de UM item no Mercado da Comunidade (`/market/priceoverview/`).
 *
 * Devolve o contrato de ticker do projeto. Duas honestidades registradas:
 *  - `ultimo` é o MENOR preço à venda (`lowest_price`) — é o que se paga hoje
 *    por aquele item, o mais próximo de "preço atual" que este mercado tem.
 *  - `maxima`/`minima` NÃO existem aqui (não há candle). Ficam iguais ao
 *    `ultimo` em vez de null porque o restante do sistema espera números; a
 *    volatilidade do dia calculada sobre isso dá 0, que é o valor honesto para
 *    "não medimos isso" — nunca um número inventado.
 * `volume` é a quantidade VENDIDA nas últimas 24 h (unidades, não dinheiro).
 */
export async function obterPreco(marketHashName, { moeda = MOEDA_BRL, appid = APPID_CS2 } = {}) {
  const dados = await requisitar(BASE_COMUNIDADE, '/market/priceoverview/', {
    appid,
    currency: moeda,
    market_hash_name: marketHashName,
  });
  if (!dados?.success) {
    throw new ErroSteam(`item sem preço no mercado: ${marketHashName}`, { endpoint: '/market/priceoverview/' });
  }
  // `lowest_price` some quando não há nenhuma oferta à venda; nesse caso o
  // `median_price` (últimas vendas) ainda descreve o valor do item.
  const preco = precoParaNumero(dados.lowest_price) ?? precoParaNumero(dados.median_price);
  if (preco === null) {
    throw new ErroSteam(`preço ilegível para ${marketHashName}`, { endpoint: '/market/priceoverview/' });
  }
  return {
    simbolo: marketHashName,
    ultimo: preco,
    maxima: preco,
    minima: preco,
    volume: quantidadeParaNumero(dados.volume),
    mediana: precoParaNumero(dados.median_price),
    horario: new Date().toISOString(),
  };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Preço de vários itens, em SÉRIE e com pausa entre as chamadas — não existe
 * endpoint de lote e o limite é de ~20/min. Item que falhar fica FORA do mapa
 * (patrimônio subestimado = postura conservadora, igual à do conector da Toro).
 * Um 429 interrompe a varredura: insistir só prolonga o bloqueio.
 */
export async function obterPrecos(nomes, { moeda = MOEDA_BRL, appid = APPID_CS2, pausaMs = 3_500, dormir = esperar } = {}) {
  const mapa = {};
  const lista = Array.isArray(nomes) ? nomes : [];
  for (let i = 0; i < lista.length; i++) {
    try {
      mapa[lista[i]] = await obterPreco(lista[i], { moeda, appid });
    } catch (e) {
      if (e instanceof ErroSteam && e.limiteExcedido) break;
      /* item indisponível: fica fora do mapa */
    }
    if (pausaMs > 0 && i < lista.length - 1) await dormir(pausaMs);
  }
  return mapa;
}

// ---------------------------------------------------------------- inventário

/**
 * Junta `assets` (as unidades que o dono tem) com `descriptions` (o que cada
 * uma É) e devolve uma linha por item DISTINTO, com a quantidade somada.
 * Função pura — é onde mora toda a regra, e por isso é o que os testes cobrem.
 *
 * Cinco cases iguais viram UMA linha com `quantidade: 5`: é o que combina com
 * o resto do sistema, onde um ativo tem um saldo.
 */
export function normalizarInventario(resposta) {
  const assets = Array.isArray(resposta?.assets) ? resposta.assets : [];
  const descricoes = Array.isArray(resposta?.descriptions) ? resposta.descriptions : [];

  const porChave = new Map();
  for (const d of descricoes) {
    porChave.set(`${d.classid}_${d.instanceid}`, d);
  }

  const itens = new Map();
  for (const a of assets) {
    const d = porChave.get(`${a.classid}_${a.instanceid}`);
    if (!d?.market_hash_name) continue; // item sem identidade de mercado
    const nome = d.market_hash_name;
    const atual = itens.get(nome);
    const quantidade = Number(a.amount) || 1;
    if (atual) {
      atual.quantidade += quantidade;
      continue;
    }
    itens.set(nome, {
      market_hash_name: nome,
      id: slugDoItem(nome),
      nome: d.name ?? nome,
      tipo: d.type ?? null,
      icon_url: d.icon_url ?? null,
      imagem: urlDaImagem(d.icon_url),
      // `marketable: 0` = item que não pode ser vendido no mercado (souvenir
      // travado, item de evento). Ele APARECE na tela — o dono pediu todos —,
      // mas não tem preço a consultar, e é isso que o campo avisa.
      negociavel: Number(d.marketable) === 1,
      quantidade,
    });
  }

  return [...itens.values()].sort((a, b) => a.market_hash_name.localeCompare(b.market_hash_name));
}

// ------------------------------------------------ notícias/atualizações do jogo
//
// Aqui, e só aqui, existe API OFICIAL: `ISteamNews/GetNewsForApp` é documentada
// pela Valve e não pede chave. É a fonte das notas de atualização do CS2 —
// e, num mercado de skin, atualização do jogo É o fundamento: case nova,
// operação nova, mudança de drop ou nerf de arma mexem no preço mais que
// qualquer indicador técnico.

// Canal oficial do jogo. O feed também traz republicações de sites parceiros,
// que não têm o mesmo peso e ficam de fora.
export const FEED_OFICIAL = 'steam_community_announcements';

/**
 * BBCode do Steam → texto simples. Função PURA. A nota vem com `[b]`, `[list]`,
 * `[url=...]`, `[img]` etc., que só ocupariam espaço no prompt e no Telegram.
 * Links viram o TEXTO do link (a URL em si não ajuda a IA a decidir nada).
 */
export function limparBBCode(texto) {
  return String(texto ?? '')
    // A Valve ESCAPA colchetes literais: os títulos das notas do CS2 chegam
    // como `\[ GAMEPLAY ]`. Desescapar é o primeiro passo — depois disso eles
    // não parecem mais tag e sobrevivem à limpeza, que é o certo.
    .replace(/\\([[\]])/g, '$1')
    .replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, '') // imagem não vira nada
    .replace(/\[url[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1') // link vira o texto dele
    // `[/*]` fecha item de lista e não cabe na regra geral abaixo (`*` não é
    // letra). Sem esta linha ele sobra no meio do texto — foi o que apareceu na
    // primeira leitura das notas reais.
    .replace(/\[\/\*\]/g, '')
    // Tags de BLOCO viram quebra de linha, não vazio: sem isso o fim de uma
    // lista cola no título seguinte ("Caixa novaMapas") e a nota chega à IA
    // como um parágrafo único e ilegível.
    .replace(/\[\/?(list|h[1-6]|p|quote|table|tr|td|hr)[^\]]*\]/gi, '\n')
    // DEPOIS dos blocos, de propósito: as notas reais vêm como `[*][p]texto`,
    // então o `\s*` aqui precisa comer a quebra que o `[p]` acabou de virar —
    // senão o marcador fica sozinho numa linha e o texto cai na seguinte.
    .replace(/\[\*\]\s*/g, '\n- ')
    .replace(/\[\/?[a-z][^\]]*\]/gi, '') // qualquer outra tag (negrito, cor…)
    .replace(/<[^>]+>/g, '') // HTML solto, quando o anúncio vem em HTML
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Corta a nota no limite sem partir palavra. Função PURA.
 * Nota de atualização do CS2 passa fácil de 10 mil caracteres; mandar tudo para
 * a IA gastaria contexto com changelog de mapa que não move preço nenhum.
 */
export function resumirNota(texto, limite = 4000) {
  const t = String(texto ?? '');
  if (t.length <= limite) return t;
  const corte = t.slice(0, limite);
  const quebra = Math.max(corte.lastIndexOf('\n'), corte.lastIndexOf(' '));
  return `${corte.slice(0, quebra > limite * 0.6 ? quebra : limite).trimEnd()}\n[…]`;
}

/**
 * Resposta do ISteamNews → lista normalizada, da mais RECENTE para a mais
 * antiga. Função PURA. O `gid` é o id estável do anúncio — é por ele que se
 * sabe se a notícia é nova, nunca pela data (que muda quando a Valve edita a
 * nota) nem pelo título (que é sempre "Counter-Strike 2 Update").
 */
export function normalizarNoticias(resposta, { feed = FEED_OFICIAL, limite = 4000 } = {}) {
  const itens = Array.isArray(resposta?.appnews?.newsitems) ? resposta.appnews.newsitems : [];
  return itens
    .filter((n) => n?.gid && (!feed || n.feedname === feed))
    .map((n) => ({
      gid: String(n.gid),
      titulo: String(n.title ?? '').trim() || 'Atualização',
      url: n.url ?? null,
      data: Number.isFinite(Number(n.date)) ? new Date(Number(n.date) * 1000).toISOString() : null,
      conteudo: resumirNota(limparBBCode(n.contents), limite),
    }))
    .sort((a, b) => String(b.data ?? '').localeCompare(String(a.data ?? '')));
}

/**
 * Últimas notícias oficiais do jogo. `maxlength=0` traz a nota inteira (o corte
 * é nosso, e feito depois da limpeza do BBCode — cortar antes deixaria tag
 * aberta no meio do texto).
 */
export async function obterNoticias({ appid = APPID_CS2, quantidade = 10, feed = FEED_OFICIAL, limite = 4000 } = {}) {
  const dados = await requisitar(BASE_API, '/ISteamNews/GetNewsForApp/v2/', {
    appid,
    count: quantidade,
    maxlength: 0,
    format: 'json',
  });
  return normalizarNoticias(dados, { feed, limite });
}

/**
 * Inventário PÚBLICO do dono (`/inventory/{steamid}/{appid}/{contextid}`).
 * Exige o inventário marcado como público no perfil da Steam — é o único
 * caminho que não pede cookie de conta.
 */
export async function obterInventario(steamId, { appid = APPID_CS2, contextid = CONTEXTID_ITENS, limite = 2000 } = {}) {
  const id = String(steamId ?? '').trim();
  if (!/^\d{17}$/.test(id)) {
    throw new ErroSteam(`SteamID64 inválido: ${JSON.stringify(steamId)} (são 17 dígitos)`, {
      endpoint: '/inventory/',
    });
  }
  const dados = await requisitar(BASE_COMUNIDADE, `/inventory/${id}/${appid}/${contextid}`, {
    l: 'english', // nomes de item em inglês: é a grafia que o mercado usa
    count: limite,
  });
  // Inventário privado responde 200 com corpo vazio/`success: false` — a causa
  // mais provável é essa, e a mensagem precisa dizer o que fazer.
  if (!dados || dados.success === false || (!dados.assets && !dados.descriptions)) {
    throw new ErroSteam(
      `não foi possível ler o inventário de ${id} — confira se ele está PÚBLICO no perfil da Steam`,
      { endpoint: '/inventory/' },
    );
  }
  return normalizarInventario(dados);
}
