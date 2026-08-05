// conectorSTEAM.test.js — conector do Mercado da Comunidade Steam em modo
// assistido (ROADMAP prioridade 4, fase 1): leitura de preço formatado,
// inventário público, rodízio de preços e — o caso que mais importa — a
// garantia de que ORDEM NUNCA É ENVIADA.
// O fetch global é substituído por um stub: nenhum teste toca a rede.
// Rodar com: npm test

import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ErroSteam,
  precoParaNumero,
  quantidadeParaNumero,
  slugDoItem,
  urlDaImagem,
  normalizarInventario,
  obterPreco,
  obterPrecos,
  obterInventario,
  limparBBCode,
  resumirNota,
  normalizarNoticias,
  FEED_OFICIAL,
} from '../src/conectores/steam/steamPublico.js';
import {
  noticiasNovas,
  gidsAtualizados,
  verificarNoticias,
  esquecerEstadoNoticias,
  GIDS_LEMBRADOS,
} from '../src/nucleo/noticiasJogo.js';
import { formatarNoticiaJogo, formatarAlertaPreco } from '../src/notificacoes/telegram.js';
import { avaliarAlertas } from '../src/nucleo/alertasPreco.js';
import { acrescentarPonto, resumirSerie } from '../src/nucleo/seriePreco.js';
import { montarPromptSistema } from '../src/ia/montadorPrompt.js';
import { executarCicloAtivo } from '../src/nucleo/cicloAtivo.js';
import {
  criarConectorSTEAM,
  intervalosDaPlataforma,
  INTERVALO_MINIMO_MINUTOS,
} from '../src/conectores/steam/conectorSTEAM.js';
import {
  deveAtualizar,
  fatiaDoRodizio,
  mesclarPrecos,
  totalDoInventario,
  atualizarInventario,
  esquecerEstadoInventario,
} from '../src/nucleo/inventarioSteam.js';
import {
  inicializarPersistencia,
  obterInventarioPlataforma,
  obterNoticiasPlataforma,
  obterSeriePrecoAtivo,
  obterAlertasPlataforma,
  salvarEstadoPlataforma,
  salvarDocBruto,
} from '../src/firebase/firebaseClient.js';

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });
beforeEach(() => { esquecerEstadoInventario(); });

const respostaJson = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Stub de fetch roteado por caminho ('GET /market/priceoverview/' → resultado). */
function stubFetch(rotas) {
  const chamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const chave = `GET ${u.pathname}`;
    chamadas.push({ chave, url: u, headers: init.headers ?? {} });
    const plano = rotas[chave];
    if (plano === undefined) return respostaJson({ erro: `rota não esperada: ${chave}` }, 500);
    const resultado = typeof plano === 'function' ? plano({ url: u, chamadas }) : plano;
    return resultado instanceof Response ? resultado : respostaJson(resultado);
  };
  return chamadas;
}

const AK = 'AK-47 | Redline (Field-Tested)';

// ------------------------------------------------------------------- números
// A Steam não devolve número nenhum: só texto já formatado na moeda pedida.
// Ler isso errado é ler o PREÇO errado, então é o que mais tem teste.

test('preço formatado: reais com milhar (última ocorrência manda)', () => {
  assert.equal(precoParaNumero('R$ 1.234,56'), 1234.56);
  assert.equal(precoParaNumero('R$ 12,34'), 12.34);
  assert.equal(precoParaNumero('R$ 0,03'), 0.03);
});

test('preço formatado: dólar com a convenção invertida', () => {
  assert.equal(precoParaNumero('$1,234.56'), 1234.56);
  assert.equal(precoParaNumero('$12.34'), 12.34);
});

test('preço formatado: separador único com 3 casas é MILHAR, não decimal', () => {
  // "R$ 1,234" em pt-BR seria 1,234 reais; na formatação da Steam é 1234.
  // Errar aqui erraria o preço por mil vezes.
  assert.equal(precoParaNumero('R$ 1,234'), 1234);
  assert.equal(precoParaNumero('1.234'), 1234);
});

test('preço ilegível vira null — nunca zero, que se confundiria com "de graça"', () => {
  assert.equal(precoParaNumero(''), null);
  assert.equal(precoParaNumero('—'), null);
  assert.equal(precoParaNumero(undefined), null);
  assert.equal(precoParaNumero(null), null);
});

test('quantidade vendida: separador é só milhar', () => {
  assert.equal(quantidadeParaNumero('1,234'), 1234);
  assert.equal(quantidadeParaNumero('7'), 7);
  assert.equal(quantidadeParaNumero(undefined), 0);
});

// --------------------------------------------------------------------- itens

test('slug do item: nome de skin vira id de documento válido', () => {
  const slug = slugDoItem(AK);
  assert.equal(slug, 'AK_47_REDLINE_FIELD_TESTED');
  // O que o Firestore não aceita num id, e o que quebraria o CAMINHO do doc:
  assert.ok(!slug.includes('/'));
  assert.ok(!slug.includes('|'));
  assert.ok(!slug.includes(' '));
});

test('slug: nome com barra (adesivo de time) não vira dois níveis de caminho', () => {
  assert.ok(!slugDoItem('Sticker | Team/Player | Katowice 2014').includes('/'));
});

test('imagem sai do CDN da Steam a partir do icon_url (nada é hospedado por nós)', () => {
  assert.equal(
    urlDaImagem('abc123'),
    'https://community.cloudflare.steamstatic.com/economy/image/abc123/128fx128f',
  );
  assert.equal(urlDaImagem(null), null);
});

// ---------------------------------------------------------------- inventário

const INVENTARIO_CRU = {
  success: true,
  assets: [
    { classid: '1', instanceid: '0', amount: '1' },
    { classid: '2', instanceid: '0', amount: '1' },
    { classid: '2', instanceid: '0', amount: '1' }, // segundo case igual
    { classid: '2', instanceid: '0', amount: '1' }, // terceiro
    { classid: '9', instanceid: '0', amount: '1' }, // sem descrição
  ],
  descriptions: [
    { classid: '1', instanceid: '0', market_hash_name: AK, name: 'AK-47 | Redline', type: 'Rifle', icon_url: 'ak', marketable: 1 },
    { classid: '2', instanceid: '0', market_hash_name: 'Fracture Case', name: 'Fracture Case', type: 'Container', icon_url: 'case', marketable: 1 },
  ],
};

test('inventário: itens iguais viram UMA linha com a quantidade somada', () => {
  const itens = normalizarInventario(INVENTARIO_CRU);
  const caixa = itens.find((i) => i.market_hash_name === 'Fracture Case');
  assert.equal(caixa.quantidade, 3);
  assert.equal(itens.length, 2); // o asset sem descrição não vira item
});

test('inventário: cada item carrega imagem, id e se é negociável', () => {
  const [ak] = normalizarInventario(INVENTARIO_CRU);
  assert.equal(ak.market_hash_name, AK);
  assert.equal(ak.id, 'AK_47_REDLINE_FIELD_TESTED');
  assert.equal(ak.imagem, 'https://community.cloudflare.steamstatic.com/economy/image/ak/128fx128f');
  assert.equal(ak.negociavel, true);
});

test('inventário: item não negociável ENTRA na lista, marcado', () => {
  // O dono pediu que TODOS apareçam; o que muda é que este não tem preço a
  // consultar — e é o campo que avisa isso, não a ausência do item.
  const itens = normalizarInventario({
    assets: [{ classid: '5', instanceid: '0', amount: '1' }],
    descriptions: [{ classid: '5', instanceid: '0', market_hash_name: 'Souvenir X', icon_url: 'x', marketable: 0 }],
  });
  assert.equal(itens.length, 1);
  assert.equal(itens[0].negociavel, false);
});

test('inventário privado dá erro que diz o que fazer', async () => {
  stubFetch({ 'GET /inventory/76561198000000000/730/2': { success: false } });
  await assert.rejects(
    () => obterInventario('76561198000000000'),
    (e) => e instanceof ErroSteam && /P[ÚU]BLICO/i.test(e.message),
  );
});

test('SteamID inválido nem chega a chamar a rede', async () => {
  const chamadas = stubFetch({});
  await assert.rejects(() => obterInventario('eu-mesmo'), (e) => e instanceof ErroSteam);
  assert.equal(chamadas.length, 0);
});

// --------------------------------------------------------------------- preço

test('preço: resposta da Steam normalizada para o contrato de ticker', async () => {
  const chamadas = stubFetch({
    'GET /market/priceoverview/': { success: true, lowest_price: 'R$ 42,50', median_price: 'R$ 44,00', volume: '1,234' },
  });
  const t = await obterPreco(AK);
  assert.equal(t.ultimo, 42.5);
  assert.equal(t.mediana, 44);
  assert.equal(t.volume, 1234);
  // maxima/minima não existem neste mercado: ficam iguais ao preço, o que dá
  // volatilidade 0 — "não medimos", nunca um número inventado.
  assert.equal(t.maxima, 42.5);
  assert.equal(t.minima, 42.5);
  assert.equal(chamadas[0].url.searchParams.get('market_hash_name'), AK);
  assert.equal(chamadas[0].url.searchParams.get('currency'), '7');
});

test('preço: sem oferta à venda, cai para a mediana das últimas vendas', async () => {
  stubFetch({ 'GET /market/priceoverview/': { success: true, median_price: 'R$ 10,00', volume: '3' } });
  assert.equal((await obterPreco(AK)).ultimo, 10);
});

test('preços em lote: item que falha fica FORA do mapa, sem derrubar os outros', async () => {
  let n = 0;
  stubFetch({
    'GET /market/priceoverview/': () => {
      n += 1;
      return n === 1 ? { success: false } : { success: true, lowest_price: 'R$ 5,00', volume: '1' };
    },
  });
  const mapa = await obterPrecos(['A', 'B'], { pausaMs: 0 });
  assert.deepEqual(Object.keys(mapa), ['B']);
});

test('preços em lote: 429 INTERROMPE a varredura (insistir prolonga o bloqueio)', async () => {
  const chamadas = stubFetch({
    'GET /market/priceoverview/': () => respostaJson({}, 429),
  });
  const mapa = await obterPrecos(['A', 'B', 'C'], { pausaMs: 0 });
  assert.deepEqual(mapa, {});
  assert.equal(chamadas.length, 1, 'parou na primeira recusa em vez de queimar as três');
});

// ------------------------------------------------------------------ conector

test('o conector NUNCA envia ordem — nem compra, nem venda', async () => {
  const c = criarConectorSTEAM({ plataforma: { id: 'STEAM', moeda: 'BRLS' }, api: {} });
  await assert.rejects(() => c.ordemMercado({ par: AK, lado: 'buy', valor: 10 }), /assistida/i);
  await assert.rejects(() => c.aguardarFill('x', AK), /assistida/i);
});

test('candles são recusados com explicação — nunca um array vazio virando indicador falso', async () => {
  const c = criarConectorSTEAM({ plataforma: { id: 'STEAM' }, api: {} });
  await assert.rejects(() => c.candles(AK), (e) => e instanceof ErroSteam && /candles/i.test(e.message));
});

test('inventário sem SteamID configurado avisa o dono, não quebra feio', async () => {
  const c = criarConectorSTEAM({ plataforma: { id: 'STEAM' }, api: {} });
  await assert.rejects(() => c.inventario(), (e) => e instanceof ErroSteam && /SteamID64/.test(e.message));
});

test('saldos vêm da carteira MANUAL da plataforma, na moeda travada da Steam', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  await salvarEstadoPlataforma('STEAM', {
    carteira_manual: { saldo_moeda: 137.5, saldos: { [slugDoItem(AK)]: 2 } },
  });
  const c = criarConectorSTEAM({ plataforma: { id: 'STEAM', moeda: 'BRLS' }, api: {} });
  const s = await c.saldos();
  assert.equal(s.moeda, 'BRLS');
  assert.equal(s.saldo_moeda, 137.5);
  assert.equal(s.saldos[slugDoItem(AK)], 2);
});

// ---------------------------------------------------------------- intervalos

test('intervalos: valor do dono vale, com piso de 15 min', () => {
  const i = intervalosDaPlataforma({ intervalos: { analise_minutos: 120, precos_minutos: 5, noticias_minutos: 45 } });
  assert.equal(i.analise_minutos, 120);
  assert.equal(i.precos_minutos, INTERVALO_MINIMO_MINUTOS, 'abaixo do piso é elevado ao piso');
  assert.equal(i.noticias_minutos, 45);
});

test('intervalos: zero/lixo/ausente cai no padrão — nunca NaN, nunca loop', () => {
  const i = intervalosDaPlataforma({ intervalos: { analise_minutos: 0, precos_minutos: 'toda hora', noticias_minutos: -5 } });
  assert.equal(i.analise_minutos, 60);
  assert.equal(i.precos_minutos, 60);
  assert.equal(i.noticias_minutos, 30);
  assert.deepEqual(intervalosDaPlataforma({}), { analise_minutos: 60, precos_minutos: 60, noticias_minutos: 30 });
});

// ------------------------------------------------------- retrato/rodízio
const ITENS = [
  { market_hash_name: 'A', quantidade: 1, negociavel: true },
  { market_hash_name: 'B', quantidade: 2, negociavel: true },
  { market_hash_name: 'C', quantidade: 1, negociavel: false },
  { market_hash_name: 'D', quantidade: 1, negociavel: true },
];

test('rodízio: pega os próximos e dá a volta na lista', () => {
  const p1 = fatiaDoRodizio(ITENS, 0, 2);
  assert.deepEqual(p1.nomes, ['A', 'B']);
  const p2 = fatiaDoRodizio(ITENS, p1.proximoCursor, 2);
  assert.deepEqual(p2.nomes, ['D', 'A'], 'não negociável fica de fora e o cursor dá a volta');
});

test('rodízio: inventário vazio não quebra nem gera chamada', () => {
  assert.deepEqual(fatiaDoRodizio([], 0, 5), { nomes: [], proximoCursor: 0 });
});

test('retrato: item fora da fatia PRESERVA o preço anterior, com a data dele', () => {
  const anteriores = [{ market_hash_name: 'B', preco: 9, preco_em: '2026-08-01T00:00:00.000Z', volume_24h: 5 }];
  const itens = mesclarPrecos(ITENS, { A: { ultimo: 10, volume: 3 } }, anteriores, '2026-08-05T00:00:00.000Z');
  const a = itens.find((i) => i.market_hash_name === 'A');
  const b = itens.find((i) => i.market_hash_name === 'B');
  assert.equal(a.preco, 10);
  assert.equal(a.preco_em, '2026-08-05T00:00:00.000Z');
  assert.equal(b.preco, 9, 'preço velho continua na tela em vez de piscar');
  assert.equal(b.preco_em, '2026-08-01T00:00:00.000Z', 'e diz que é velho');
});

test('retrato NÃO guarda se o item é analisado — quem responde isso é o ativo', () => {
  // Um espelho aqui seria uma segunda verdade sobre o mesmo fato, e é assim
  // que nasce dado velho com cara de fresco (V7.0/V7.3).
  const [item] = mesclarPrecos([ITENS[0]], {}, [{ market_hash_name: 'A', analisado: true }]);
  assert.equal('analisado' in item, false);
});

test('retrato: valor total é preço × quantidade; sem preço, fica null e NÃO conta zero', () => {
  const itens = mesclarPrecos(ITENS, { B: { ultimo: 4.5, volume: 1 } }, [], '2026-08-05T00:00:00.000Z');
  const b = itens.find((i) => i.market_hash_name === 'B');
  assert.equal(b.valor_total, 9);
  assert.equal(itens.find((i) => i.market_hash_name === 'A').valor_total, null);
  assert.equal(totalDoInventario(itens), 9, 'itens sem preço ficam fora do total');
});

test('relógio do inventário: primeira vez sempre atualiza; depois espera o intervalo', () => {
  assert.equal(deveAtualizar(undefined, 60), true);
  const agora = Date.parse('2026-08-05T12:00:00Z');
  assert.equal(deveAtualizar(agora - 59 * 60_000, 60, agora), false);
  assert.equal(deveAtualizar(agora - 60 * 60_000, 60, agora), true);
});

test('atualização: publica o retrato e não repete antes do intervalo', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  let inventarios = 0;
  const conector = {
    async inventario() { inventarios += 1; return normalizarInventario(INVENTARIO_CRU); },
    async precos(nomes) {
      return Object.fromEntries(nomes.map((n) => [n, { ultimo: 2, volume: 1 }]));
    },
  };
  const plataforma = { id: 'STEAM', intervalos: { precos_minutos: 60 } };
  const agoraMs = Date.parse('2026-08-05T12:00:00Z');

  const r1 = await atualizarInventario({ plataforma, conector, agoraMs });
  assert.equal(r1.atualizado, true);
  const doc = await obterInventarioPlataforma('STEAM');
  assert.equal(doc.itens.length, 2);
  assert.equal(doc.erro, null);

  const r2 = await atualizarInventario({ plataforma, conector, agoraMs: agoraMs + 60_000 });
  assert.equal(r2.atualizado, false, 'um minuto depois ainda não é hora');
  assert.equal(inventarios, 1, 'e nenhuma chamada nova foi feita');
});

// ==================================================== fase 2: atualizações do CS2
// O "ouvinte" das notas de atualização. Aqui, e só aqui, a fonte é API OFICIAL
// da Valve (ISteamNews) — sem chave e sem cookie.

const FEED = {
  appnews: {
    appid: 730,
    newsitems: [
      {
        gid: 'A1', title: 'Counter-Strike 2 Update', url: 'https://x/a1',
        date: 1785791934, feedname: 'steam_community_announcements',
        contents: '[list][*] Adicionada a caixa Fracture[/list]\n[b]Mapas[/b]\n[url=https://y]Detalhes[/url]',
      },
      {
        gid: 'A2', title: 'Cologne 2026', url: 'https://x/a2',
        date: 1785285504, feedname: 'steam_community_announcements',
        contents: 'Comece a apostar nos times.',
      },
      {
        gid: 'B1', title: 'Notícia de site parceiro', url: 'https://x/b1',
        date: 1785285490, feedname: 'blog_de_terceiro',
        contents: 'clique aqui',
      },
    ],
  },
};

test('BBCode vira texto simples: lista, negrito e link somem — o texto fica', () => {
  const t = limparBBCode('[list][*] Caixa nova[/list][b]Mapas[/b] [url=https://y]Detalhes[/url][img]x[/img]');
  assert.match(t, /- Caixa nova/);
  assert.match(t, /Mapas/);
  assert.match(t, /Detalhes/, 'link vira o TEXTO dele — a URL não ajuda a IA a decidir');
  assert.ok(!t.includes('['), 'nenhuma tag sobrou');
  assert.ok(!t.includes('https://y'));
});

test('BBCode REAL do CS2: o formato que a Valve usa de verdade', () => {
  // Trecho copiado de uma nota de produção (2026-08-03). O teste sintético
  // acima passava e ESTE não: as notas reais vêm com `[p]` dentro do item de
  // lista, com `[/*]` fechando o item (que não é letra, e escapava da regra
  // geral) e com colchete literal escapado (`\[ GAMEPLAY ]`). Os três defeitos
  // só apareceram ao ler a API de verdade.
  const cru = '[p]\\[ GAMEPLAY ][/p][list][*][p]Fixed a case where grenades could be thrown[/p][/*]'
    + '[*][p]Fixed collision in various spots[/p][/*][/list][p]\\[ MAPS ][/p][p]Cache[/p]';
  const t = limparBBCode(cru);

  assert.match(t, /\[ GAMEPLAY \]/, 'título literal sobrevive, sem a barra de escape');
  assert.match(t, /^- Fixed a case where grenades could be thrown$/m, 'item numa linha só');
  assert.ok(!t.includes('[/*]'), 'fim de item de lista não sobra no texto');
  assert.ok(!t.includes('[p]') && !t.includes('[/p]'));
  assert.ok(!/^- *$/m.test(t), 'nenhum marcador sozinho numa linha');
  assert.ok(!t.includes('\\'), 'nenhuma barra de escape sobrou');
});

test('nota gigante é cortada sem partir palavra', () => {
  const nota = `${'palavra '.repeat(2000)}fim`;
  const curta = resumirNota(nota, 100);
  assert.ok(curta.length <= 120);
  assert.match(curta, /\[…\]$/);
  assert.ok(!/palavr$/.test(curta.replace(/\n\[…\]$/, '')), 'não cortou no meio da palavra');
});

test('nota curta não é mexida', () => {
  assert.equal(resumirNota('tudo bem', 4000), 'tudo bem');
});

test('feed: só o canal OFICIAL entra, mais recente primeiro, com data legível', () => {
  const itens = normalizarNoticias(FEED);
  assert.deepEqual(itens.map((n) => n.gid), ['A1', 'A2'], 'site parceiro fica de fora');
  assert.equal(itens[0].titulo, 'Counter-Strike 2 Update');
  assert.match(itens[0].data, /^2026-/);
  assert.ok(!itens[0].conteudo.includes('[list]'));
});

test('notícia sem gid é ignorada — sem id estável não há como saber se é nova', () => {
  const itens = normalizarNoticias({ appnews: { newsitems: [{ title: 'x', feedname: FEED_OFICIAL }] } });
  assert.equal(itens.length, 0);
});

test('novidade é decidida pelo GID, nunca pela data ou pelo título', () => {
  // Todos os anúncios do CS2 se chamam "Counter-Strike 2 Update", e a Valve
  // edita notas já publicadas (a data muda). Só o gid é estável.
  const itens = normalizarNoticias(FEED);
  const novas = noticiasNovas(itens, ['A2']);
  assert.deepEqual(novas.map((n) => n.gid), ['A1']);
  assert.deepEqual(noticiasNovas(itens, ['A1', 'A2']), [], 'nada novo = nenhum aviso');
});

test('PRIMEIRA leitura não avisa nada — senão o dono receberia 10 avisos velhos de uma vez', () => {
  assert.deepEqual(noticiasNovas(normalizarNoticias(FEED), [], true), []);
});

test('memória de gids não deixa anúncio antigo voltar a ser novidade', () => {
  const gids = gidsAtualizados(normalizarNoticias(FEED), ['Z9']);
  assert.deepEqual(gids.slice(0, 3), ['A1', 'A2', 'Z9']);
  assert.equal(new Set(gids).size, gids.length, 'sem repetição');
  assert.ok(gids.length <= GIDS_LEMBRADOS);
});

test('aviso do Telegram é curto: título, link e duas linhas da nota', () => {
  const txt = formatarNoticiaJogo({
    titulo: 'Counter-Strike 2 Update',
    url: 'https://x/a1',
    data: '2026-08-04T12:00:00Z',
    conteudo: 'linha 1\nlinha 2\nlinha 3 que não deve aparecer',
  });
  assert.match(txt, /Counter-Strike 2 Update/);
  assert.match(txt, /https:\/\/x\/a1/);
  assert.match(txt, /linha 1 linha 2/);
  assert.ok(!txt.includes('linha 3'), 'o changelog inteiro quem lê é a IA, no prompt');
});

test('ouvinte: primeira rodada só APRENDE; a segunda avisa só o que é novo', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  esquecerEstadoNoticias();
  const avisos = [];
  const conector = { async noticias() { return normalizarNoticias(FEED); } };
  const plataforma = { id: 'STEAM', intervalos: { noticias_minutos: 30 } };
  const configTelegram = { bot_token: 't', chat_id: '1', eventos: { noticia_jogo: true } };
  globalThis.fetch = async (url, init) => {
    avisos.push(JSON.parse(init.body).text);
    return respostaJson({ ok: true, result: {} });
  };

  const agoraMs = Date.parse('2026-08-05T12:00:00Z');
  const r1 = await verificarNoticias({ plataforma, conector, agoraMs, configTelegram });
  assert.deepEqual(r1.novas, [], 'primeira leitura não avisa');
  assert.equal(avisos.length, 0);

  // Sai um anúncio novo; 31 minutos depois, o ouvinte acorda.
  const feed2 = { appnews: { newsitems: [
    { gid: 'A3', title: 'Counter-Strike 2 Update', url: 'https://x/a3', date: 1785891934, feedname: FEED_OFICIAL, contents: 'Caixa nova' },
    ...FEED.appnews.newsitems,
  ] } };
  conector.noticias = async () => normalizarNoticias(feed2);
  const r2 = await verificarNoticias({ plataforma, conector, agoraMs: agoraMs + 31 * 60_000, configTelegram });
  assert.deepEqual(r2.novas.map((n) => n.gid), ['A3']);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /Counter-Strike 2 Update/);
});

test('ouvinte: sem novidade não escreve no banco (seria uma escrita por rodada para dizer "igual")', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  esquecerEstadoNoticias();
  const conector = { async noticias() { return normalizarNoticias(FEED); } };
  const plataforma = { id: 'STEAM' };
  const agoraMs = Date.parse('2026-08-05T12:00:00Z');

  await verificarNoticias({ plataforma, conector, agoraMs }); // aprende
  const depoisDaPrimeira = await obterNoticiasPlataforma('STEAM');
  const r = await verificarNoticias({ plataforma, conector, agoraMs: agoraMs + 60 * 60_000 });
  assert.deepEqual(r.novas, []);
  assert.equal(
    (await obterNoticiasPlataforma('STEAM')).atualizado_em,
    depoisDaPrimeira.atualizado_em,
    'o documento não foi tocado',
  );
});

test('ouvinte: Steam fora do ar não lança e não perde a memória do que já viu', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  esquecerEstadoNoticias();
  const conector = { async noticias() { throw new ErroSteam('HTTP 503'); } };
  const r = await verificarNoticias({ plataforma: { id: 'STEAM' }, conector });
  assert.equal(r.consultado, false);
  assert.match(r.erro, /503/);
});

test('ouvinte: respeita o intervalo configurado pelo dono', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  esquecerEstadoNoticias();
  let chamadas = 0;
  const conector = { async noticias() { chamadas += 1; return []; } };
  const plataforma = { id: 'STEAM', intervalos: { noticias_minutos: 30 } };
  const agoraMs = Date.parse('2026-08-05T12:00:00Z');
  await verificarNoticias({ plataforma, conector, agoraMs });
  await verificarNoticias({ plataforma, conector, agoraMs: agoraMs + 29 * 60_000 });
  assert.equal(chamadas, 1, 'não consultou de novo antes da hora');
  await verificarNoticias({ plataforma, conector, agoraMs: agoraMs + 31 * 60_000 });
  assert.equal(chamadas, 2);
});

test('conector: notícias vêm da API oficial da Valve, sem chave nenhuma', async () => {
  const chamadas = stubFetch({ 'GET /ISteamNews/GetNewsForApp/v2/': FEED });
  const c = criarConectorSTEAM({ plataforma: { id: 'STEAM' }, api: {} });
  const itens = await c.noticias();
  assert.deepEqual(itens.map((n) => n.gid), ['A1', 'A2']);
  assert.equal(chamadas[0].url.hostname, 'api.steampowered.com');
  assert.equal(chamadas[0].url.searchParams.get('appid'), '730');
  assert.equal(chamadas[0].url.searchParams.get('key'), null, 'endpoint público: nenhuma chave viaja');
});

// ============================== fase 3: análise sem candle, com notícia no prompt

test('série própria: ponto entra, mas não a cada 15 minutos', () => {
  // Amostrar de 15 em 15 min encheria a série de ruído e encolheria o passado
  // guardado de 30 dias para 7.
  const t0 = '2026-08-01T00:00:00.000Z';
  let s = acrescentarPonto([], { t: t0, p: 10 });
  assert.equal(s.length, 1);
  s = acrescentarPonto(s, { t: '2026-08-01T00:15:00.000Z', p: 11 });
  assert.equal(s.length, 1, 'cedo demais: ignorado');
  s = acrescentarPonto(s, { t: '2026-08-01T01:00:00.000Z', p: 11 });
  assert.equal(s.length, 2);
});

test('série própria: preço inválido nunca entra (viraria variação inventada)', () => {
  const s = [{ t: '2026-08-01T00:00:00.000Z', p: 10 }];
  assert.equal(acrescentarPonto(s, { t: '2026-08-02T00:00:00.000Z', p: null }).length, 1);
  assert.equal(acrescentarPonto(s, { t: '2026-08-02T00:00:00.000Z', p: 0 }).length, 1);
});

test('série própria: janela que a série AINDA não cobre volta null, nunca 0', () => {
  // É a diferença entre "não subiu" e "não sei". Confundir as duas foi o que
  // cegou a métrica de assimetria na V8.1.
  const agora = new Date('2026-08-05T12:00:00Z');
  const pontos = [
    { t: '2026-08-04T12:00:00.000Z', p: 100 },
    { t: '2026-08-05T12:00:00.000Z', p: 110 },
  ];
  const r = resumirSerie(pontos, agora);
  assert.equal(r.variacao_24h, 10, 'a série cobre 24 h: 100 → 110 = +10%');
  assert.equal(r.variacao_7d, null, 'não cobre 7 dias');
  assert.equal(r.variacao_30d, null);
  assert.equal(r.maxima, 110);
  assert.equal(r.minima, 100);
  assert.equal(r.dias_de_historico, 1);
});

test('série própria: sem nenhum ponto, tudo é null e nada quebra', () => {
  const r = resumirSerie([], new Date());
  assert.equal(r.pontos, 0);
  assert.equal(r.variacao_24h, null);
  assert.equal(r.maxima, null);
});

test('prompt: a plataforma da Steam NÃO recebe as regras gerais', () => {
  const p = montarPromptSistema({
    manifest: { id: 'X', nome: 'X', tipo: 'skin', par: 'X', plataforma: 'STEAM' },
    plataforma: { id: 'STEAM', usaRegrasGerais: false },
    regrasGerais: { conteudo: 'REGRAS GERAIS DO SISTEMA' },
    template: { conteudo: 'REGRAS DA STEAM' },
  });
  assert.ok(!p.texto.includes('REGRAS GERAIS DO SISTEMA'));
  assert.ok(p.texto.includes('REGRAS DA STEAM'));
  assert.match(p.partes[0], /REGRAS DA STEAM/, 'o texto da Steam é a PRIMEIRA camada');
});

test('prompt: TODAS as outras plataformas continuam recebendo as regras gerais', () => {
  // O caso que protege o sistema inteiro: o flag é da Steam e não pode vazar.
  for (const plataforma of [null, { id: 'MB' }, { id: 'BN', usaRegrasGerais: true }]) {
    const p = montarPromptSistema({
      manifest: { id: 'BTC', nome: 'BTC', tipo: 'crypto', par: 'BTC-BRL', plataforma: 'MB' },
      plataforma,
      regrasGerais: { conteudo: 'REGRAS GERAIS DO SISTEMA' },
      template: { conteudo: 'template' },
    });
    assert.ok(p.texto.includes('REGRAS GERAIS DO SISTEMA'), `falhou para ${JSON.stringify(plataforma)}`);
  }
});

test('prompt: sem regras gerais e sem template, NÃO cai na semente de ativo financeiro', () => {
  // A semente fala de RSI/MACD/candles. Numa plataforma que dispensou as regras
  // gerais por não ter nada disso, cair nela seria pior que ficar sem texto.
  const p = montarPromptSistema({
    manifest: { id: 'X', nome: 'X', tipo: 'skin', par: 'X', plataforma: 'STEAM' },
    plataforma: { id: 'STEAM', usaRegrasGerais: false },
    template: { conteudo: '' },
  });
  // Sobram exatamente duas camadas: a identidade do item e o contrato de saída.
  // (Não dá para procurar "RSI" no texto inteiro: o contrato de saída cita a
  // sigla num exemplo de justificativa, e sempre citará.)
  assert.equal(p.partes.length, 2);
  assert.match(p.partes[0], /# Ativo em análise/);
  assert.match(p.partes[1], /Formato de saída/);
});

test('prompt: a LIQUIDAÇÃO ignora o flag — ordem do dono vale em toda plataforma', () => {
  const p = montarPromptSistema({
    manifest: { id: 'X', nome: 'X', tipo: 'skin', par: 'X', plataforma: 'STEAM' },
    plataforma: { id: 'STEAM', usaRegrasGerais: false },
    regrasGeraisVenda: { conteudo: 'REGRAS DE LIQUIDAÇÃO' },
    template: { conteudo: 'REGRAS DA STEAM' },
    modoVendas: { ativo: true, dia: 2, dias_totais: 7, perda_maxima_percentual: 5 },
  });
  assert.match(p.partes[0], /REGRAS DE LIQUIDAÇÃO/);
});

test('prompt: as atualizações do jogo entram, e antes do contrato de saída', () => {
  const p = montarPromptSistema({
    manifest: { id: 'X', nome: 'X', tipo: 'skin', par: 'X', plataforma: 'STEAM' },
    plataforma: { id: 'STEAM', usaRegrasGerais: false },
    template: { conteudo: 'REGRAS DA STEAM' },
    noticias: { itens: [{ gid: 'A1', titulo: 'CS2 Update', data: '2026-08-03T00:00:00Z', conteudo: 'Caixa nova adicionada' }] },
  });
  const iNoticia = p.partes.findIndex((x) => x.includes('Caixa nova adicionada'));
  const iContrato = p.partes.findIndex((x) => x.includes('Formato de saída'));
  assert.ok(iNoticia > 0, 'a notícia entrou no prompt');
  assert.ok(iNoticia < iContrato, 'e o formato de saída continua sendo a última palavra');
  assert.match(p.texto, /2026-08-03/, 'com a data — anúncio velho pesa menos');
});

test('prompt: ativo com usaNoticias:false não recebe a camada', () => {
  const p = montarPromptSistema({
    manifest: { id: 'BTC', nome: 'BTC', tipo: 'crypto', par: 'BTC-BRL', plataforma: 'MB', usaNoticias: false },
    plataforma: { id: 'MB' },
    template: { conteudo: 'template' },
    noticias: { itens: [{ gid: 'A1', titulo: 'CS2 Update', conteudo: 'Caixa nova' }] },
  });
  assert.ok(!p.texto.includes('Caixa nova'));
});

test('ciclo do item: sem candle, sem indicador inventado — e com a série própria', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  let pediuCandles = false;
  const conector = {
    id: 'steam',
    precoAtual: async (par) => ({ simbolo: par, ultimo: 42.5, maxima: 42.5, minima: 42.5, volume: 1234, mediana: 44 }),
    precos: async (pares) => Object.fromEntries(pares.map((p) => [p, { ultimo: 42.5 }])),
    candles: async () => { pediuCandles = true; throw new Error('não deveria ser chamado'); },
    saldos: async () => ({ moeda: 'BRLS', saldo_moeda: 100, saldos: {} }),
    ordensAbertas: async () => [],
    ordemMercado: async () => { throw new Error('assistida nunca envia ordem'); },
    aguardarFill: async () => { throw new Error('assistida não tem fill'); },
  };
  const item = {
    id: 'AK_47_REDLINE_FIELD_TESTED',
    manifest: {
      id: 'AK_47_REDLINE_FIELD_TESTED', nome: 'AK-47 | Redline', tipo: 'skin',
      plataforma: 'STEAM', par: AK, mercado24h: true,
      usaIndicadores: false, usaSupervisao: false,
    },
    config: {
      ativo: true, modo_simulacao: false, orcamento_percentual: 0,
      percentual_minimo_variacao: 0.3, tempo_reset_dias: 7,
      taxa_compra_percentual: 0, taxa_venda_percentual: 13.04,
      minimo_ordem_valor: 0.03, minimo_ordem_quantidade: 1,
    },
  };

  let cenarioVisto = null;
  const r = await executarCicloAtivo({
    plataforma: { id: 'STEAM', assistida: true, moeda: 'BRLS', usaRegrasGerais: false, modelos_ia: ['m'] },
    api: { api_key_ia: 'chave' },
    ativo: item,
    ativosDaPlataforma: [item],
    conector,
    decidirFn: async (cenario) => {
      cenarioVisto = cenario;
      return { acao: 'AGUARDAR', percentual: 0, justificativa: 'sem tese', valida: true };
    },
  });

  assert.equal(r.tipo, 'analise');
  assert.equal(pediuCandles, false, 'não pediu candle a um mercado que não tem candle');
  // Os indicadores que não existem chegam como null EXPLÍCITO — a IA precisa
  // saber que não existem, não achar que esqueceram de enviar.
  assert.equal(cenarioVisto.indicadores.rsi, null);
  assert.equal(cenarioVisto.indicadores.macd, null);
  assert.equal(cenarioVisto.indicadores.unidades_vendidas_24h, 1234);
  assert.equal(cenarioVisto.indicadores.preco_mediano, 44);
  // E a série própria já nasce com o primeiro ponto.
  assert.equal(cenarioVisto.serie_preco.pontos, 1);
  assert.equal(cenarioVisto.serie_preco.variacao_24h, null, 'um ponto não responde 24 h');
  assert.equal((await obterSeriePrecoAtivo('STEAM', item.id)).pontos.length, 1);
});

test('ciclo: notícia nova FURA o filtro de variação (o preço se move depois do anúncio)', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  const conector = {
    id: 'steam',
    precoAtual: async (par) => ({ simbolo: par, ultimo: 42.5, maxima: 42.5, minima: 42.5, volume: 1, mediana: 42.5 }),
    precos: async (pares) => Object.fromEntries(pares.map((p) => [p, { ultimo: 42.5 }])),
    candles: async () => { throw new Error('não deveria ser chamado'); },
    saldos: async () => ({ moeda: 'BRLS', saldo_moeda: 100, saldos: {} }),
    ordensAbertas: async () => [],
    ordemMercado: async () => { throw new Error('nunca'); },
    aguardarFill: async () => { throw new Error('nunca'); },
  };
  const item = {
    id: 'CASE', manifest: { id: 'CASE', nome: 'Case', tipo: 'skin', plataforma: 'STEAM', par: 'Fracture Case', mercado24h: true, usaIndicadores: false, usaSupervisao: false },
    config: { ativo: true, modo_simulacao: false, orcamento_percentual: 0, percentual_minimo_variacao: 0.3, tempo_reset_dias: 7, taxa_compra_percentual: 0, taxa_venda_percentual: 13.04, minimo_ordem_valor: 0.03, minimo_ordem_quantidade: 1 },
  };
  const comum = {
    plataforma: { id: 'STEAM', assistida: true, moeda: 'BRLS', usaRegrasGerais: false, modelos_ia: ['m'] },
    api: { api_key_ia: 'chave' },
    ativo: item,
    ativosDaPlataforma: [item],
    conector,
    decidirFn: async () => ({ acao: 'AGUARDAR', percentual: 0, justificativa: 'x', valida: true }),
  };

  const r1 = await executarCicloAtivo(comum); // 1ª: estabelece a base
  assert.equal(r1.tipo, 'analise');
  // Preço idêntico: no fluxo normal o filtro engoliria a rodada.
  const r2 = await executarCicloAtivo({ ...comum, estado: r1.estado });
  assert.equal(r2.tipo, 'sem_variacao');
  // Com notícia nova, analisa mesmo sem o preço ter mexido.
  const r3 = await executarCicloAtivo({ ...comum, estado: r1.estado, forcarAnalise: true });
  assert.equal(r3.tipo, 'analise');
});

// ================================== fase 5: alerta de preço-alvo por item

const ITEM_AK = { id: 'AK', market_hash_name: AK, quantidade: 1, negociavel: true };

test('alerta: dispara ao cruzar o alvo para baixo, e só UMA vez', () => {
  const alvos = { AK: { abaixo: 40 } };
  const r1 = avaliarAlertas([{ ...ITEM_AK, preco: 39 }], alvos, {});
  assert.equal(r1.disparos.length, 1);
  assert.equal(r1.disparos[0].tipo, 'abaixo');
  assert.equal(r1.disparos[0].preco, 39);

  // Item parado abaixo do alvo NÃO pode gerar um aviso por hora, para sempre —
  // é assim que o dono desliga os avisos, que é o pior desfecho.
  const r2 = avaliarAlertas([{ ...ITEM_AK, preco: 38 }], alvos, r1.estado);
  assert.deepEqual(r2.disparos, []);
});

test('alerta: rearma quando o preço volta, e avisa na travessia seguinte', () => {
  const alvos = { AK: { abaixo: 40 } };
  const r1 = avaliarAlertas([{ ...ITEM_AK, preco: 39 }], alvos, {});
  const r2 = avaliarAlertas([{ ...ITEM_AK, preco: 45 }], alvos, r1.estado); // rearma
  assert.deepEqual(r2.disparos, []);
  assert.equal(r2.estado.AK.disparado_abaixo, false);
  const r3 = avaliarAlertas([{ ...ITEM_AK, preco: 39.5 }], alvos, r2.estado);
  assert.equal(r3.disparos.length, 1, 'nova queda = novo aviso');
});

test('alerta: alvo de alta é o espelho exato', () => {
  const alvos = { AK: { acima: 50 } };
  const r = avaliarAlertas([{ ...ITEM_AK, preco: 51 }], alvos, {});
  assert.equal(r.disparos[0].tipo, 'acima');
  assert.deepEqual(avaliarAlertas([{ ...ITEM_AK, preco: 52 }], alvos, r.estado).disparos, []);
});

test('alerta: preço exatamente no alvo conta como cruzado', () => {
  assert.equal(avaliarAlertas([{ ...ITEM_AK, preco: 40 }], { AK: { abaixo: 40 } }, {}).disparos.length, 1);
  assert.equal(avaliarAlertas([{ ...ITEM_AK, preco: 50 }], { AK: { acima: 50 } }, {}).disparos.length, 1);
});

test('alerta: item sem preço legível não dispara nada (null não é zero)', () => {
  const r = avaliarAlertas([{ ...ITEM_AK, preco: null }], { AK: { abaixo: 40 } }, {});
  assert.deepEqual(r.disparos, []);
});

test('alerta: item sem alvo configurado é ignorado', () => {
  assert.deepEqual(avaliarAlertas([{ ...ITEM_AK, preco: 1 }], {}, {}).disparos, []);
  assert.deepEqual(avaliarAlertas([{ ...ITEM_AK, preco: 1 }], { AK: { abaixo: null } }, {}).disparos, []);
});

test('alerta: os dois alvos podem disparar no mesmo item, em momentos diferentes', () => {
  const alvos = { AK: { abaixo: 40, acima: 60 } };
  const r1 = avaliarAlertas([{ ...ITEM_AK, preco: 39 }], alvos, {});
  assert.deepEqual(r1.disparos.map((d) => d.tipo), ['abaixo']);
  const r2 = avaliarAlertas([{ ...ITEM_AK, preco: 61 }], alvos, r1.estado);
  assert.deepEqual(r2.disparos.map((d) => d.tipo), ['acima']);
  assert.equal(r2.estado.AK.disparado_abaixo, false, 'o de baixa rearmou no caminho');
});

test('alerta no Telegram: diz o alvo E o preço de agora', () => {
  const txt = formatarAlertaPreco({ nome: AK, tipo: 'abaixo', alvo: 40, preco: 38.5, moeda: 'BRLS' });
  assert.match(txt, /AK-47/);
  assert.match(txt, /38[.,]50/);
  assert.match(txt, /40[.,]00/);
});

test('alertas na rodada de preços: avisa e grava o estado, sem consulta nova à Steam', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  esquecerEstadoInventario();
  await salvarDocBruto('plataformas/STEAM/dados', 'alertas', { itens: { FRACTURE_CASE: { abaixo: 5 } } });

  const avisos = [];
  globalThis.fetch = async (url, init) => {
    avisos.push(JSON.parse(init.body).text);
    return respostaJson({ ok: true, result: {} });
  };
  let consultasDePreco = 0;
  const conector = {
    async inventario() { return normalizarInventario(INVENTARIO_CRU); },
    async precos(nomes) {
      consultasDePreco += 1;
      return Object.fromEntries(nomes.map((n) => [n, { ultimo: 2, volume: 1 }]));
    },
  };

  const r = await atualizarInventario({
    plataforma: { id: 'STEAM', moeda: 'BRLS' },
    conector,
    configTelegram: { bot_token: 't', chat_id: '1', eventos: { alerta_preco: true } },
  });
  assert.equal(r.atualizado, true);
  assert.equal(consultasDePreco, 1, 'os alertas usaram os preços que já tinham chegado');
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /Fracture Case/);
  const alertas = await obterAlertasPlataforma('STEAM');
  assert.equal(alertas.estado.FRACTURE_CASE.disparado_abaixo, true, 'gravou para não repetir');
  assert.deepEqual(alertas.itens.FRACTURE_CASE, { abaixo: 5 }, 'o alvo do dono não foi tocado');
});

test('atualização: Steam fora do ar NÃO lança e preserva o retrato anterior', async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  const conector = {
    async inventario() { throw new ErroSteam('Steam respondeu HTTP 503'); },
    async precos() { return {}; },
  };
  const r = await atualizarInventario({
    plataforma: { id: 'STEAM' },
    conector,
    anteriores: [{ market_hash_name: 'A', quantidade: 1, preco: 3, valor_total: 3 }],
  });
  assert.equal(r.atualizado, false);
  const doc = await obterInventarioPlataforma('STEAM');
  assert.equal(doc.itens.length, 1, 'o que estava na tela continua');
  assert.match(doc.erro, /503/, 'e a tela passa a saber por que não atualizou');
});
