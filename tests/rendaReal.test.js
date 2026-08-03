// rendaReal.test.js — comparativo de renda real × 106% do CDI: matemática das
// taxas, consulta da Selic (com fallbacks) e agregação/persistência do doc
// global/renda_real sobre a persistência em memória. Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERCENTUAL_CDI,
  SELIC_FALLBACK_AA,
  cdiDaSelic,
  benchmarkAA,
  taxaEquivalente,
  taxaEquivalenteDiasUteis,
  taxaAnualizada,
  taxasPorPeriodo,
  diasUteisEntre,
  feriadosBrasil,
  domingoDePascoa,
  obterSelicAA,
  atualizarRendaReal,
  obterCotacaoUSD,
  atualizarCambio,
  converterLucroParaBRL,
  USD_FALLBACK_BRL,
} from '../src/nucleo/rendaReal.js';
import {
  inicializarPersistencia,
  salvarPlataforma,
  salvarAtivo,
  salvarEstatisticasAtivo,
  salvarEstadoPlataforma,
  obterRendaReal,
  obterCambio,
  salvarConfigRenda,
} from '../src/firebase/firebaseClient.js';
import { invalidarCatalogo } from '../src/nucleo/catalogo.js';

const aprox = (real, esperado, tolerancia = 0.01) =>
  assert.ok(Math.abs(real - esperado) <= tolerancia, `esperava ~${esperado}, veio ${real}`);

// ------------------------------------------------------------ matemática pura

test('CDI aproxima a Selic menos 0,10 p.p. (nunca negativo)', () => {
  assert.equal(cdiDaSelic(15), 14.9);
  assert.equal(cdiDaSelic(0.05), 0);
});

test('106% do CDI capitaliza a taxa DIÁRIA (rende mais que 1,06 × taxa anual)', () => {
  const bench = benchmarkAA(14.9);
  aprox(bench, 15.86, 0.05); // conta de referência: diária ×1,06 composta em 252
  assert.ok(bench > 14.9 * 1.06 - 0.2 && bench > 14.9);
  assert.equal(benchmarkAA(0), 0);
});

test('taxa equivalente e anualização são inversas e coerentes', () => {
  aprox(taxaEquivalente(15, 365), 15, 1e-9);
  const mes = taxasPorPeriodo(15).mes;
  aprox(mes, 1.17, 0.01); // 1,15^(1/12)-1 ≈ 1,171%/mês
  aprox(taxasPorPeriodo(15).semana, taxaEquivalente(15, 7), 0.01);
  // rendimento de 1,171% em ~30,4 dias volta para ~15% a.a.
  aprox(taxaAnualizada(1.171, 365 / 12), 15, 0.05);
  assert.equal(taxaAnualizada(5, 0), null);
  assert.equal(taxaAnualizada(-100, 30), null);
});

// ------------------------------------------------------ calendário de dias úteis

test('Páscoa e feriados móveis derivados dela (2026)', () => {
  // Domingo de Páscoa de 2026 = 05/04.
  assert.equal(domingoDePascoa(2026).toISOString().slice(0, 10), '2026-04-05');
  const feriados = feriadosBrasil(2026);
  assert.ok(feriados.has('2026-01-01')); // fixo
  assert.ok(feriados.has('2026-04-03')); // Sexta-feira Santa (Páscoa − 2)
  assert.ok(feriados.has('2026-02-16')); // Carnaval segunda (Páscoa − 48)
  assert.ok(feriados.has('2026-02-17')); // Carnaval terça (Páscoa − 47)
  assert.ok(feriados.has('2026-06-04')); // Corpus Christi (Páscoa + 60)
  assert.ok(feriados.has('2026-11-20')); // Consciência Negra
});

test('dias úteis não contam fim de semana nem feriado', () => {
  // Mesmo instante → 0. Sexta → sábado/domingo → 0 (CDI não rende no fim de semana).
  const sexta = new Date('2026-07-31T12:00:00Z'); // sexta-feira
  assert.equal(diasUteisEntre(sexta, sexta), 0);
  assert.equal(diasUteisEntre(sexta, new Date('2026-08-01T12:00:00Z')), 0); // sábado
  assert.equal(diasUteisEntre(sexta, new Date('2026-08-02T12:00:00Z')), 0); // domingo
  assert.equal(diasUteisEntre(sexta, new Date('2026-08-03T12:00:00Z')), 1); // segunda
  // Semana cheia (seg→seg seguinte) = 5 dias úteis.
  assert.equal(diasUteisEntre(new Date('2026-08-03T00:00:00Z'), new Date('2026-08-10T00:00:00Z')), 5);
  // Feriado no meio: 07/09 (Independência, segunda) não conta.
  // Sex 04/09 → ter 08/09: contam segunda(feriado→0) e terça(1) = só a terça.
  assert.equal(diasUteisEntre(new Date('2026-09-04T12:00:00Z'), new Date('2026-09-08T12:00:00Z')), 1);
});

test('taxa equivalente em dias úteis usa base 252 (fecha o ano com 252 úteis)', () => {
  aprox(taxaEquivalenteDiasUteis(15, 252), 15, 1e-9);
  aprox(taxaEquivalenteDiasUteis(15, 0), 0, 1e-9);
});

// ----------------------------------------------------------------- Selic (BCB)

const fetchOk = (valor) => async () => ({
  ok: true,
  json: async () => [{ data: '16/07/2026', valor }],
});
const fetchFalha = async () => {
  throw new Error('rede indisponível');
};

test('Selic via API do BCB (aceita vírgula decimal no valor)', async () => {
  assert.equal((await obterSelicAA({ fetchFn: fetchOk('15.00') })).taxa_aa, 15);
  const comVirgula = await obterSelicAA({ fetchFn: fetchOk('13,75') });
  assert.equal(comVirgula.taxa_aa, 13.75);
  assert.equal(comVirgula.fonte, 'api_bcb');
});

test('falha na API cai para a taxa anterior; sem anterior, para o padrão do código', async () => {
  const anterior = { taxa_aa: 14.25, consultada_em: '2026-07-01T00:00:00Z' };
  const reaproveitada = await obterSelicAA({ fetchFn: fetchFalha, anterior });
  assert.equal(reaproveitada.taxa_aa, 14.25);
  assert.equal(reaproveitada.fonte, 'anterior');

  const padrao = await obterSelicAA({ fetchFn: fetchFalha });
  assert.equal(padrao.taxa_aa, SELIC_FALLBACK_AA);
  assert.equal(padrao.fonte, 'padrao');
});

// --------------------------------------------------------------- agregação

const AGORA = new Date('2026-07-30T12:00:00Z');

async function semearCenario() {
  await inicializarPersistencia({ modo: 'memoria' });
  invalidarCatalogo(); // o catálogo em memória sobrevive à troca de backend
  await salvarPlataforma('MB', { nome: 'Mercado Bitcoin', moeda: 'BRL' });
  await salvarPlataforma('TT', { nome: 'Tastytrade', moeda: 'USD' });
  // BTC REAL com lucro 30; ETH em SIMULAÇÃO com lucro 999 (não pode entrar).
  await salvarAtivo('MB', 'BTC', {
    manifest: { id: 'BTC', par: 'BTC-BRL' },
    config: { modo_simulacao: false },
  });
  await salvarAtivo('MB', 'ETH', {
    manifest: { id: 'ETH', par: 'ETH-BRL' },
    config: { modo_simulacao: true },
  });
  await salvarEstatisticasAtivo('MB', 'BTC', 'real', { lucro_total: 30 });
  await salvarEstatisticasAtivo('MB', 'ETH', 'simulacao', { lucro_total: 999 });
  await salvarEstatisticasAtivo('MB', 'ETH', 'real', { lucro_total: 555 }); // sobra de fase real antiga
  // Ação REAL em USD: entra no total por moeda, mas fora da comparação BRL.
  await salvarAtivo('TT', 'AAPL', {
    manifest: { id: 'AAPL', par: 'AAPL' },
    config: { modo_simulacao: false },
  });
  await salvarEstatisticasAtivo('TT', 'AAPL', 'real', { lucro_total: 2 });
  // Principal da comparação: patrimônio real do dia na plataforma BRL.
  await salvarEstadoPlataforma('MB', { patrimonio_inicio_dia: { real: { data: '2026-07-30', valor: 1000 } } });
}

beforeEach(semearCenario);

test('soma só o lucro real de ativos FORA da simulação, por moeda', async () => {
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.equal(doc.lucro_real_total, 30); // BRL: só o BTC (ETH em simulação fica fora)
  assert.deepEqual(doc.lucro_real_por_moeda, { BRL: 30, USD: 2 });
  assert.equal(doc.moeda_comparacao, 'BRL');
  assert.equal(doc.patrimonio_inicial, 1000);
  assert.equal(doc.selic.taxa_aa, 15);
  assert.equal(doc.selic.cdi_aa, 14.9);
  assert.equal(doc.selic.percentual_cdi, PERCENTUAL_CDI);
  aprox(doc.selic.benchmark_aa, 15.86, 0.05);
});

test('converterLucroParaBRL soma BRL direto, converte estrangeiras e reporta as sem câmbio', () => {
  const cambio = { base: 'BRL', USD: { para_brl: 5 } };
  // BRL 30 + USD 2 × 5 = 40; sem cotação de EUR → fica de fora e é reportado.
  const r = converterLucroParaBRL({ BRL: 30, USD: 2, EUR: 7 }, cambio);
  assert.equal(r.total, 40);
  assert.deepEqual(r.moedasSemCambio, ['EUR']);
  // Sem câmbio nenhum: só o BRL entra; moeda zerada NÃO vira "sem câmbio".
  const semCambio = converterLucroParaBRL({ BRL: 30, USD: 2, EUR: 0 }, null);
  assert.equal(semCambio.total, 30);
  assert.deepEqual(semCambio.moedasSemCambio, ['USD']);
});

test('lucro em moeda estrangeira é convertido para BRL e entra na comparação (câmbio do BCB)', async () => {
  await atualizarCambio({ agora: AGORA, fetchFn: fetchOk('5.00') }); // USD→BRL = 5
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  // BRL 30 (BTC) + USD 2 (AAPL) × 5 = 40 no total comparado com o CDI.
  assert.equal(doc.lucro_real_total, 40);
  assert.equal(doc.comparativo.lucro_bot, 40);
  aprox(doc.comparativo.bot.periodo, 4, 0.01); // 40 sobre o principal 1000
  // O detalhamento por moeda continua NATIVO (cabeçalho "R$ … · US$ …").
  assert.deepEqual(doc.lucro_real_por_moeda, { BRL: 30, USD: 2 });
  assert.deepEqual(doc.moedas_sem_cambio, []); // USD tinha cotação
});

test('sem cotação de câmbio, a moeda estrangeira fica fora do total e é reportada', async () => {
  // Nenhum câmbio gravado (semearCenario não semeia global/cambio).
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.equal(doc.lucro_real_total, 30); // só o BRL entra
  assert.deepEqual(doc.lucro_real_por_moeda, { BRL: 30, USD: 2 }); // por moeda intacto
  assert.deepEqual(doc.moedas_sem_cambio, ['USD']);
});

test('Selic manual (global/config_renda) sobrepõe a API do BCB', async () => {
  await salvarConfigRenda({ selic_manual: 20 });
  // fetchFalha: se dependesse da API, cairia no fallback; com manual, nem consulta.
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchFalha });
  assert.equal(doc.selic.taxa_aa, 20);
  assert.equal(doc.selic.fonte, 'manual');
  assert.equal(doc.selic.cdi_aa, 19.9); // 20 − 0,10 p.p.
});

test('percentual do CDI manual muda o benchmark e o rótulo persistido', async () => {
  await salvarConfigRenda({ percentual_cdi: 130 });
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.equal(doc.selic.percentual_cdi, 130);
  aprox(doc.selic.benchmark_aa, benchmarkAA(14.9, 130), 0.01);
  assert.ok(doc.selic.benchmark_aa > benchmarkAA(14.9, 106)); // 130% rende mais que 106%
});

test('limpar a Selic manual volta a usar a API do BCB (não congela o valor antigo)', async () => {
  await salvarConfigRenda({ selic_manual: 20, percentual_cdi: 106 });
  const manual = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.equal(manual.selic.fonte, 'manual');
  await salvarConfigRenda({ selic_manual: null }); // dono apaga o campo → API de novo
  const depois = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.equal(depois.selic.taxa_aa, 15);
  assert.equal(depois.selic.fonte, 'api_bcb');
});

test('início da comparação é fixado uma vez e não anda nas atualizações seguintes', async () => {
  const primeiro = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.equal(primeiro.inicio_comparacao, AGORA.toISOString());
  assert.equal(primeiro.dias_comparacao, 0);
  // no primeiro instante ainda não dá para anualizar o robô (menos de 1 dia)
  assert.equal(primeiro.comparativo.bot.ano, null);
  aprox(primeiro.comparativo.bot.periodo, 3, 0.01); // 30 de lucro sobre 1000

  const depois = new Date(AGORA.getTime() + 30 * 86_400_000);
  const segundo = await atualizarRendaReal({ agora: depois, fetchFn: fetchOk('15.00') });
  assert.equal(segundo.inicio_comparacao, AGORA.toISOString());
  assert.equal(segundo.dias_comparacao, 30);
  // 3% em 30 dias ≈ 43% a.a.; benchmark acumula SÓ em dias úteis (base 252).
  aprox(segundo.comparativo.bot.ano, 43.25, 0.5);
  const du = diasUteisEntre(AGORA, depois); // 30 dias corridos = 21 úteis (qui→sáb)
  assert.equal(du, 21);
  assert.equal(segundo.dias_uteis_comparacao, 21);
  aprox(
    segundo.comparativo.benchmark.periodo,
    taxaEquivalenteDiasUteis(segundo.selic.benchmark_aa, du),
    0.01,
  );
  aprox(
    segundo.comparativo.rendimento_benchmark,
    1000 * (taxaEquivalenteDiasUteis(segundo.selic.benchmark_aa, du) / 100),
    0.1,
  ); // R$ sobre o principal de 1000
});

test('sem ativo real, o bloco REAL não nasce — mas o de SIMULAÇÃO sim (V6.2)', async () => {
  await salvarAtivo('MB', 'BTC', { config: { modo_simulacao: true } });
  await salvarAtivo('TT', 'AAPL', { config: { modo_simulacao: true } });
  invalidarCatalogo();
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  // Real ainda não começou → sem os campos de topo.
  assert.equal(doc.inicio_comparacao, undefined);
  assert.equal(doc.lucro_real_total, undefined);
  // Simulação existe (ETH sempre em simulação + BTC/AAPL agora em simulação).
  assert.ok(doc.simulacao);
  assert.equal(doc.simulacao.inicio_comparacao, AGORA.toISOString());
  assert.equal(doc.simulacao.lucro_por_moeda.BRL, 999); // só ETH tem lucro simulado
});

test('sem ativo em NENHUM modo (e sem comparação iniciada), nada é gravado', async () => {
  // Remove todos os ativos das duas plataformas semeadas.
  await inicializarPersistencia({ modo: 'memoria' });
  invalidarCatalogo();
  await salvarPlataforma('MB', { nome: 'Mercado Bitcoin', moeda: 'BRL' });
  assert.equal(await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') }), null);
  assert.equal(await obterRendaReal(), null);
});

test('ativo que volta para a simulação sai do total (moeda zera em vez de congelar)', async () => {
  await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  await salvarAtivo('TT', 'AAPL', { config: { modo_simulacao: true } });
  invalidarCatalogo(); // em produção a edição da dashboard vale após o TTL do catálogo
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.deepEqual(doc.lucro_real_por_moeda, { BRL: 30, USD: 0 });
  // a régua da comparação continua a mesma
  assert.equal(doc.inicio_comparacao, AGORA.toISOString());
});

test('comparativo da SIMULAÇÃO usa estatísticas e principal do modo simulação (V6.2)', async () => {
  // Principal simulado da plataforma BRL (independente do real, que é 1000).
  await salvarEstadoPlataforma('MB', { patrimonio_inicio_dia: { simulacao: { data: '2026-07-30', valor: 2000 } } });
  invalidarCatalogo();
  const doc = await atualizarRendaReal({ agora: AGORA, fetchFn: fetchOk('15.00') });
  assert.ok(doc.simulacao);
  assert.equal(doc.simulacao.lucro_total, 999); // BRL: só ETH (em simulação)
  assert.equal(doc.simulacao.patrimonio_inicial, 2000);
  assert.equal(doc.simulacao.inicio_comparacao, AGORA.toISOString());
  aprox(doc.simulacao.comparativo.bot.periodo, 49.95, 0.01); // 999 sobre 2000
  // O bloco real segue independente no topo do doc.
  assert.equal(doc.lucro_real_total, 30);
});

test('câmbio USD→BRL vem da API do BCB, com fallback para a última / o padrão', async () => {
  assert.equal((await obterCotacaoUSD({ fetchFn: fetchOk('5.43') })).taxa_brl, 5.43);
  const reaproveitado = await obterCotacaoUSD({
    fetchFn: fetchFalha,
    anterior: { taxa_brl: 5.1, consultada_em: '2026-07-01T00:00:00Z' },
  });
  assert.equal(reaproveitado.taxa_brl, 5.1);
  assert.equal(reaproveitado.fonte, 'anterior');
  assert.equal((await obterCotacaoUSD({ fetchFn: fetchFalha })).taxa_brl, USD_FALLBACK_BRL);
});

test('atualizarCambio grava global/cambio e reaproveita dentro do TTL de 6 h', async () => {
  let chamadas = 0;
  const fetchContando = async (...args) => {
    chamadas += 1;
    return fetchOk('5.40')(...args);
  };
  const doc = await atualizarCambio({ agora: AGORA, fetchFn: fetchContando });
  assert.equal(doc.base, 'BRL');
  assert.equal(doc.USD.para_brl, 5.4);
  assert.equal((await obterCambio()).USD.para_brl, 5.4);
  await atualizarCambio({ agora: new Date(AGORA.getTime() + 60_000), fetchFn: fetchContando });
  assert.equal(chamadas, 1); // dentro do TTL, sem nova chamada
  await atualizarCambio({ agora: new Date(AGORA.getTime() + 7 * 60 * 60_000), fetchFn: fetchContando });
  assert.equal(chamadas, 2);
});

test('Selic recente é reaproveitada sem nova chamada à API (TTL de 6 h)', async () => {
  let chamadas = 0;
  const fetchContando = async (...args) => {
    chamadas += 1;
    return fetchOk('15.00')(...args);
  };
  await atualizarRendaReal({ agora: AGORA, fetchFn: fetchContando });
  await atualizarRendaReal({ agora: new Date(AGORA.getTime() + 60_000), fetchFn: fetchContando });
  assert.equal(chamadas, 1);
  await atualizarRendaReal({ agora: new Date(AGORA.getTime() + 7 * 60 * 60_000), fetchFn: fetchContando });
  assert.equal(chamadas, 2);
});
