// nucleo.test.js — núcleo multi-ativo da V2: montagem do prompt final,
// agendamento por ativo (intervalo + horário de mercado) e o ciclo completo
// de um ativo rodando de ponta a ponta com conector e IA falsos sobre a
// persistência em memória. Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { montarPromptSistema } from '../src/ia/montadorPrompt.js';
import {
  dentroDoHorarioDeMercado,
  deveAnalisarAgora,
  deveLimparEstadoEmMemoria,
  executarRodada,
  limparEstadoAtivosEmMemoria,
  montarStatusBot,
} from '../src/nucleo/orquestrador.js';
import { invalidarCatalogo } from '../src/nucleo/catalogo.js';
import { migrarV1paraV2 } from '../src/migracao/migrarV1paraV2.js';
import { obterCarteiraAtiva } from '../src/executor/executor.js';
import { abrirPosicao, lucroDaPosicao } from '../src/posicoes/posicoes.js';
import {
  inicializarPersistencia,
  obterAtivo,
  salvarAtivo,
  obterEstadoAtivo,
  obterEstadoPlataforma,
  obterPosicoesAtivoPorModo,
  obterUltimaOperacaoExecutadaAtivo,
  obterHistoricoRecenteAtivo,
  obterDashboardAtivo,
  registrarOperacaoAtivo,
  salvarContextoAtivo,
  obterContextoAtivo,
  salvarPromptAtivo,
  salvarStatusBot,
  obterStatusBot,
  obterControle,
  salvarControle,
} from '../src/firebase/firebaseClient.js';

// ------------------------------------------------------------ montadorPrompt

const MANIFEST = { id: 'BTC', nome: 'Bitcoin', tipo: 'crypto', par: 'BTC-BRL', mercado24h: true };

test('prompt final = regras gerais + template + identidade + prompt do ativo + contexto', () => {
  const { texto } = montarPromptSistema({
    manifest: MANIFEST,
    regrasGerais: { conteudo: '# Regras gerais\n\n1. Nunca venda no prejuízo.' },
    template: { conteudo: '# Você é um analista...' },
    promptAtivo: { conteudo: 'Seja conservador com este ativo.' },
    contexto: { texto: 'ETFs com fluxo positivo.', atualizado_em: '2026-07-10T12:00:00Z' },
  });
  assert.match(texto, /# Regras gerais/);
  assert.match(texto, /# Você é um analista/);
  assert.match(texto, /# Ativo em análise/);
  assert.match(texto, /nome: Bitcoin/);
  assert.match(texto, /Seja conservador com este ativo\./);
  assert.match(texto, /escrito em 2026-07-10/);
  assert.match(texto, /ETFs com fluxo positivo\./);
  // ordem: regras gerais → template → identidade → prompt do ativo → contexto
  assert.ok(texto.indexOf('Regras gerais') < texto.indexOf('analista'));
  assert.ok(texto.indexOf('analista') < texto.indexOf('Ativo em análise'));
  assert.ok(texto.indexOf('Ativo em análise') < texto.indexOf('conservador'));
  assert.ok(texto.indexOf('conservador') < texto.indexOf('ETFs'));
});

test('validade do contexto (V6.2): sem validade → entra e PEDE que a IA defina', () => {
  const r = montarPromptSistema({
    manifest: MANIFEST,
    contexto: { texto: 'Fed corta juros amanhã.', atualizado_em: '2026-07-18T12:00:00Z' },
    agora: new Date('2026-07-18T13:00:00Z'),
  });
  assert.equal(r.pedeValidadeContexto, true);
  assert.match(r.texto, /Fed corta juros/);
  assert.match(r.texto, /validade_contexto_dias/);
});

test('validade do contexto (V6.2): com validade vigente → entra SEM pedir de novo', () => {
  const r = montarPromptSistema({
    manifest: MANIFEST,
    contexto: {
      texto: 'Tese de longo prazo.',
      atualizado_em: '2026-07-01T12:00:00Z',
      validade_ate: '2026-08-01T12:00:00Z',
    },
    agora: new Date('2026-07-18T13:00:00Z'),
  });
  assert.equal(r.pedeValidadeContexto, false);
  assert.match(r.texto, /Tese de longo prazo/);
  assert.doesNotMatch(r.texto, /validade_contexto_dias/);
});

test('validade do contexto (V6.2): EXPIRADO não é enviado à IA', () => {
  const r = montarPromptSistema({
    manifest: MANIFEST,
    contexto: {
      texto: 'Notícia velha.',
      atualizado_em: '2026-06-01T12:00:00Z',
      validade_ate: '2026-06-10T12:00:00Z',
    },
    agora: new Date('2026-07-18T13:00:00Z'),
  });
  assert.equal(r.pedeValidadeContexto, false);
  assert.doesNotMatch(r.texto, /Notícia velha/);
});

test('regras gerais vazias caem para a semente regras_gerais.md do repositório', () => {
  const { texto } = montarPromptSistema({ manifest: MANIFEST, regrasGerais: { conteudo: '' } });
  // Casa com o cabeçalho, não com uma regra específica: o conteúdo da semente é
  // editorial e muda: o que este teste protege é o FALLBACK existir e funcionar
  // (sem o arquivo, montar o prompt lançaria e nenhum ativo seria analisado).
  assert.match(texto, /# Regras gerais/);
  assert.match(texto, /prioridade sobre o template da plataforma/);
});

test('flags do manifest desligam partes do prompt (o núcleo não pergunta "é Bitcoin?")', () => {
  const { texto } = montarPromptSistema({
    manifest: { ...MANIFEST, usaPromptPersonalizado: false, usaContexto: false },
    template: { conteudo: '# Template' },
    promptAtivo: { conteudo: 'NÃO DEVE APARECER' },
    contexto: { texto: 'NEM ISSO', atualizado_em: '2026-07-10T12:00:00Z' },
  });
  assert.doesNotMatch(texto, /NÃO DEVE APARECER/);
  assert.doesNotMatch(texto, /NEM ISSO/);
});

test('template vazio cai para a semente do repositório (promptBase.md)', () => {
  const { texto } = montarPromptSistema({ manifest: MANIFEST, template: { conteudo: '' } });
  assert.match(texto, /# Papel/); // início do promptBase.md
});

test('contrato de saída canônico é SEMPRE anexado por último (blinda o campo `acao`)', () => {
  const { texto, partes } = montarPromptSistema({
    manifest: MANIFEST,
    regrasGerais: { conteudo: '# Regras' },
    template: { conteudo: '# Template' },
  });
  // O contrato exige o campo `acao` e é a última parte do prompt.
  assert.match(texto, /Formato de saída \(OBRIGATÓRIO/);
  assert.match(texto, /O nome do campo da ação é obrigatoriamente `acao`/);
  assert.ok(/Formato de saída \(OBRIGATÓRIO/.test(partes.at(-1)));
});

test('contrato de saída sobrepõe vocabulário concorrente do template (incidente 2026-07-19)', () => {
  // Template que só fala em `decisao`/`NO_TRADE` (como os templates reescritos
  // que quebraram a validação) ainda produz um prompt que fixa `acao`.
  const { texto } = montarPromptSistema({
    manifest: MANIFEST,
    template: { conteudo: 'Responda com `{"decisao": "NO_TRADE"}`.' },
  });
  assert.match(texto, /nunca `decisao`/);
  // O contrato vem DEPOIS do template concorrente (palavra final sobre o formato).
  assert.ok(texto.lastIndexOf('"acao"') > texto.indexOf('"decisao": "NO_TRADE"'));
});

// ------------------------------------------------------------- agendamento

test('mercado 24h opera a qualquer hora; bolsa só no pregão (aprox. seg–sex 10–18h)', () => {
  const bolsa = { mercado24h: false };
  const cripto = { mercado24h: true };
  const tz = 'America/Sao_Paulo';
  const terca14h = new Date('2026-07-14T14:00:00-03:00');
  const terca20h = new Date('2026-07-14T20:00:00-03:00');
  const sabado14h = new Date('2026-07-18T14:00:00-03:00');

  assert.equal(dentroDoHorarioDeMercado(cripto, terca20h, tz), true);
  assert.equal(dentroDoHorarioDeMercado(cripto, sabado14h, tz), true);
  assert.equal(dentroDoHorarioDeMercado(bolsa, terca14h, tz), true);
  assert.equal(dentroDoHorarioDeMercado(bolsa, terca20h, tz), false);
  assert.equal(dentroDoHorarioDeMercado(bolsa, sabado14h, tz), false);
});

test('deveAnalisarAgora respeita o intervalo do ativo (com tolerância)', () => {
  const config = { tempo_entre_analises_minutos: 15 };
  const agora = new Date('2026-07-14T12:00:00Z');
  // nunca rodou → roda
  assert.equal(deveAnalisarAgora({ config, estado: {}, agora }), true);
  // rodou há 5 min → espera
  assert.equal(
    deveAnalisarAgora({ config, estado: { horario_ultima_verificacao: '2026-07-14T11:55:00Z' }, agora }),
    false,
  );
  // rodou há 15 min → roda
  assert.equal(
    deveAnalisarAgora({ config, estado: { horario_ultima_verificacao: '2026-07-14T11:45:00Z' }, agora }),
    true,
  );
  // a verificação mais RECENTE conta (análise antiga + verificação nova)
  assert.equal(
    deveAnalisarAgora({
      config,
      estado: {
        horario_ultima_analise: '2026-07-14T10:00:00Z',
        horario_ultima_verificacao: '2026-07-14T11:58:00Z',
      },
      agora,
    }),
    false,
  );
});

// -------------------------------------------- ciclo completo (ponta a ponta)

/** Candles sintéticos: tendência suave de alta terminando em `precoFinal`. */
function candlesSinteticos(n, precoFinal) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    const preco = precoFinal * (1 - 0.001 * (n - 1 - i)) * (i % 7 === 0 ? 0.999 : 1);
    candles.push({
      horario: new Date(Date.parse('2026-07-14T00:00:00Z') + i * 900_000).toISOString(),
      abertura: preco,
      maxima: preco * 1.001,
      minima: preco * 0.999,
      fechamento: preco,
      volume: 1,
    });
  }
  return candles;
}

/** Conector falso completo (contrato de src/conectores/conector.js). */
function conectorFalso({ preco = 100000, saldoMoeda = 1000, saldos = {} } = {}) {
  return {
    id: 'falso',
    precoAtual: async (par) => ({ simbolo: par, ultimo: preco, maxima: preco * 1.01, minima: preco * 0.99 }),
    precos: async (pares) => Object.fromEntries(pares.map((p) => [p, { ultimo: preco }])),
    candles: async (par, res, n) => candlesSinteticos(n, preco),
    saldos: async () => ({ moeda: 'BRL', saldo_moeda: saldoMoeda, saldos: structuredClone(saldos) }),
    ordensAbertas: async () => [],
    ordemMercado: async () => {
      throw new Error('não deveria criar ordem real em teste');
    },
    aguardarFill: async () => {
      throw new Error('não deveria aguardar fill em teste');
    },
  };
}

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  // Os caches em memória do núcleo sobrevivem à troca de backend — sem o
  // reset, um teste enxergaria dados do backend do teste anterior.
  invalidarCatalogo();
  limparEstadoAtivosEmMemoria();
  await migrarV1paraV2(); // instalação nova: semeia MB + BTC (ligado), ETH/SOL desligados
});

test('carteira ativa grava lucro NÃO realizado (se vender tudo agora) no doc dashboard', async () => {
  const ativo = await obterAtivo('MB', 'BTC');
  ativo.config.modo_simulacao = false; // modo real: saldo vem do conector
  ativo.config.taxa_compra_percentual = 1.5;
  ativo.config.taxa_venda_percentual = 1.5;

  // Uma posição comprada a 100k; ainda vale 0,01 BTC no livro real.
  await abrirPosicao({
    plataforma: 'MB', ativo: 'BTC', modo: 'real', origem: 'bot',
    quantidade: 0.01, preco_compra: 100000,
  });

  const conector = conectorFalso({ preco: 110000, saldoMoeda: 500, saldos: { BTC: 0.01 } });
  const carteira = await obterCarteiraAtiva({ plataformaId: 'MB', ativo, conector });

  // Bate com a fórmula canônica de lucro por lote ao preço atual (§4).
  const esperado = lucroDaPosicao({ quantidade: 0.01, preco_compra: 100000 }, 110000, ativo.config);
  assert.ok(esperado > 0, 'posição deveria estar em lucro a 110k');
  assert.equal(carteira.lucro_nao_realizado, Math.round(esperado * 100) / 100);

  const { carteira_atual } = await obterDashboardAtivo('MB', 'BTC');
  assert.equal(carteira_atual.lucro_nao_realizado, carteira.lucro_nao_realizado);
});

test('rodada completa: filtro na 1ª execução não se aplica, IA compra, posição abre e caixa virtual cai', async () => {
  const decisoes = [];
  const decidirFalso = async (cenario, opcoes) => {
    decisoes.push({ cenario, opcoes });
    return {
      acao: 'COMPRAR',
      percentual: 20,
      stop_loss: 95000,
      stop_loss_motivo: 'abaixo do fundo recente',
      confianca: 80,
      justificativa: 'Teste.',
      valida: true,
      modelo: 'falso',
    };
  };
  const conector = conectorFalso({ preco: 100000, saldoMoeda: 1000 });

  // O ciclo é chamado direto (a rodada criaria o conector real do MB).
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  const ativo = await obterAtivo('MB', 'BTC');

  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector,
    decidirFn: decidirFalso,
  });

  assert.equal(r.tipo, 'analise');
  assert.equal(r.avaliacao.status, 'aprovada');
  assert.equal(r.operacao.status, 'executada');
  assert.equal(r.operacao.tipo, 'COMPRA');
  assert.equal(r.operacao.valor, 200); // 20% do caixa de 1.000

  // O cenário enviado à IA identifica o ativo e usa campos genéricos.
  const { cenario, opcoes } = decisoes[0];
  assert.equal(cenario.ativo.id, 'BTC');
  assert.equal(cenario.carteira.saldo_disponivel, 1000);
  assert.match(opcoes.promptSistema, /# Ativo em análise/);

  // Posição aberta com o preço do fill; carteira virtual debitada.
  const posicoes = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicoes.length, 1);
  assert.equal(posicoes[0].origem, 'bot');
  const estadoPlat = await obterEstadoPlataforma('MB');
  assert.equal(estadoPlat.carteira_virtual.saldo_moeda, 800);
  assert.ok(estadoPlat.carteira_virtual.saldos.BTC > 0);

  // Operação e histórico registrados no escopo do ativo.
  const op = await obterUltimaOperacaoExecutadaAtivo('MB', 'BTC');
  assert.equal(op.id, r.operacao.id);
  const historico = await obterHistoricoRecenteAtivo('MB', 'BTC', 5);
  assert.equal(historico[0].tipo, 'analise');
  assert.equal(historico[0].decisao_ia.acao, 'COMPRAR');
});

// ------------------------------------------------------- STOP-LOSS (V6.6)

/** Compra 1 lote a `preco` com o chão em `stopLoss`, devolvendo o estado do ciclo. */
async function comprarComStop({ preco = 100000, stopLoss = 95000, percentual = 20 } = {}) {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  const ativo = await obterAtivo('MB', 'BTC');
  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco, saldoMoeda: 1000 }),
    decidirFn: async () => ({
      acao: 'COMPRAR',
      percentual,
      stop_loss: stopLoss,
      stop_loss_motivo: 'abaixo do fundo recente',
      confianca: 80,
      justificativa: 'T.',
      valida: true,
    }),
  });
  assert.equal(r.operacao.status, 'executada');
  return { plataforma, ativo, estado: r.estado };
}

test('compra grava o stop-loss (e o motivo) na posição aberta', async () => {
  await comprarComStop({ preco: 100000, stopLoss: 95000 });
  const [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.stop_loss, 95000);
  assert.equal(posicao.stop_loss_motivo, 'abaixo do fundo recente');
  assert.equal(posicao.fechada_por, null);
});

test('stop-loss: preço abaixo do chão vende NO PREJUÍZO, sem chamar a IA', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const { plataforma, ativo, estado } = await comprarComStop({ preco: 100000, stopLoss: 95000 });

  // 2ª rodada: preço despenca abaixo do chão. A IA NÃO pode ser consultada.
  let chamouIA = false;
  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 94000, saldoMoeda: 800 }),
    estado,
    decidirFn: async () => {
      chamouIA = true;
      throw new Error('a IA não deve ser consultada num disparo de stop-loss');
    },
  });

  assert.equal(chamouIA, false, 'o stop-loss é decisão do Motor, não da IA');
  assert.equal(r.tipo, 'stop_loss');
  assert.equal(r.operacao.status, 'executada');
  assert.equal(r.operacao.tipo, 'VENDA');
  // O marcador da dashboard e o filtro do banco saem daqui.
  assert.equal(r.operacao.origem_decisao, 'motor_stop_loss');
  assert.ok(r.operacao.lucro_liquido < 0, 'a venda por stop realiza prejuízo — é o objetivo');
  assert.equal(r.operacao.stop_loss[0].motivo, 'abaixo do fundo recente');

  // A posição fecha marcada como stop_loss (base da análise semanal).
  const [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.status, 'FECHADA');
  assert.equal(posicao.fechada_por, 'stop_loss');
  assert.equal(posicao.aberta_modo, null);

  const historico = await obterHistoricoRecenteAtivo('MB', 'BTC', 5);
  assert.equal(historico[0].tipo, 'stop_loss');
  assert.equal(historico[0].chamou_ia, false);
});

test('stop-loss é checado ANTES do filtro de variação (queda pequena ainda dispara)', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  // O chão respeita a folga mínima do ativo (3%): 97.000 sob uma compra a
  // 100.000. Depois de uma análise a 97.050, a queda que fura o chão é de só
  // 0,05% — MENOR que o mínimo de variação (0,3%). Sem a checagem antecipada,
  // o ciclo sairia como 'sem_variacao' e o chão seria furado sem ninguém olhar.
  const { plataforma, ativo } = await comprarComStop({ preco: 100000, stopLoss: 97000 });

  const aguardar = async () => ({
    acao: 'AGUARDAR',
    percentual: 0,
    justificativa: 'T.',
    valida: true,
  });

  // Análise intermediária, só para aproximar o baseline do chão. O preço está
  // ABAIXO do breakeven, então o trailing do Motor não mexe no chão.
  await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 97050, saldoMoeda: 800 }),
    decidirFn: aguardar,
  });

  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 96999, saldoMoeda: 800 }), // variação de só 0,05%
    decidirFn: async () => {
      throw new Error('a IA não deve ser consultada');
    },
  });

  assert.equal(r.tipo, 'stop_loss');
  assert.equal(r.operacao.status, 'executada');
});

test('preço acima do chão segue o ciclo normal (o stop não interfere)', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const { plataforma, ativo, estado } = await comprarComStop({ preco: 100000, stopLoss: 95000 });

  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 110000, saldoMoeda: 800 }),
    estado,
    decidirFn: async () => ({ acao: 'AGUARDAR', percentual: 0, justificativa: 'T.', valida: true }),
  });

  assert.equal(r.tipo, 'analise');
  const [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.status, 'LUCRO');
});

test('ajuste da IA que aperta o chão dentro da folga é RECUSADO no ciclo real (V8.8)', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const { plataforma, ativo, estado } = await comprarComStop({ preco: 100000, stopLoss: 95000 });
  const [antes] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');

  // Preço subiu. A IA pede o chão a 1,8% do preço — foi exatamente isso que ela
  // fazia em produção ("elevação para a mm21"), e o lote morria no ruído.
  const r1 = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 110000, saldoMoeda: 800 }),
    estado,
    decidirFn: async () => ({
      acao: 'AGUARDAR',
      percentual: 0,
      justificativa: 'T.',
      valida: true,
      ajustes_stop_loss: [{ id: antes.id, stop_loss: 108000, motivo: 'elevação para a mm21' }],
    }),
  });

  let [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  // Quem manda no chão é o trailing do Motor: 3% de 110.000. O pedido da IA
  // ficaria a 1,8% do preço e foi descartado.
  assert.equal(posicao.stop_loss, 106700);
  assert.match(posicao.stop_loss_motivo, /trailing do Motor/);

  // Nova tentativa, agora BAIXANDO o chão: tem de ser descartada também.
  await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 112000, saldoMoeda: 800 }),
    estado: r1.estado,
    decidirFn: async () => ({
      acao: 'AGUARDAR',
      percentual: 0,
      justificativa: 'T.',
      valida: true,
      ajustes_stop_loss: [{ id: antes.id, stop_loss: 90000, motivo: 'afrouxando' }],
    }),
  });

  [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  // O pedido de 90.000 foi descartado; o chão ainda SUBIU, porque o trailing
  // automático do Motor o levou a 3% de 112.000 = 108.640.
  assert.equal(posicao.stop_loss, 108640, 'o chão não pode ser rebaixado');
  assert.ok(posicao.stop_loss > 106700, 'o chão só anda para cima');
});

test('ajuste da IA COM folga é aplicado em posição fora do lucro (o trailing não age lá)', async () => {
  // O espaço que sobra para os ajustes da IA depois da V8.8: reduzir risco de
  // lote que ainda não cobriu as taxas — onde o trailing do Motor não entra.
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const { plataforma, ativo, estado } = await comprarComStop({ preco: 100000, stopLoss: 95000 });
  const [antes] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');

  await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 101000, saldoMoeda: 800 }), // abaixo do breakeven
    estado,
    decidirFn: async () => ({
      acao: 'AGUARDAR',
      percentual: 0,
      justificativa: 'T.',
      valida: true,
      // 3,4% abaixo de 101.000: respeita a folga de 3% do ativo.
      ajustes_stop_loss: [{ id: antes.id, stop_loss: 97500, motivo: 'reduzindo risco' }],
    }),
  });

  const [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.stop_loss, 97500);
  assert.equal(posicao.stop_loss_motivo, 'reduzindo risco');
});

test('trailing do Motor sobe o chão em ciclo que NEM CHAMA a IA', async () => {
  // A propriedade que motivou o recurso: na PBR foram 127 ciclos desde a compra
  // para ~20 chamadas à IA — um trailing que só anda junto com ela fica para trás.
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const { plataforma, ativo, estado } = await comprarComStop({ preco: 100000, stopLoss: 95000 });

  // 1) Preço sobe forte: a IA é chamada e o trailing põe o chão em 3% de 110.000.
  const r1 = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 110000, saldoMoeda: 800 }),
    estado,
    decidirFn: async () => ({ acao: 'AGUARDAR', percentual: 0, justificativa: 'T.', valida: true }),
  });
  let [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.stop_loss, 106700);

  // 2) Preço sobe só 0,18%: abaixo do mínimo de variação, a IA NÃO é consultada
  //    — e ainda assim o chão tem de subir.
  let chamouIA = false;
  const r2 = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 110200, saldoMoeda: 800 }),
    estado: r1.estado,
    decidirFn: async () => {
      chamouIA = true;
      return { acao: 'AGUARDAR', percentual: 0, justificativa: 'T.', valida: true };
    },
  });

  assert.equal(chamouIA, false, 'a IA não podia ser chamada neste ciclo');
  assert.equal(r2.tipo, 'sem_variacao');
  [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.stop_loss, 106894, 'o Motor subiu o chão sozinho');
});

test('assistida: stop vira RECOMENDAÇÃO uma vez só (não repete a cada ciclo)', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo', assistida: true };
  const ativo = await obterAtivo('MB', 'BTC');
  ativo.config.modo_simulacao = false; // assistida registra operações REAIS

  await abrirPosicao({
    plataforma: 'MB', ativo: 'BTC', modo: 'real', origem: 'bot',
    quantidade: 0.01, preco_compra: 100000, stop_loss: 95000, stop_loss_motivo: 'suporte',
  });

  const rodar = (preco, estado) => executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco, saldoMoeda: 500, saldos: { BTC: 0.01 } }),
    estado,
    decidirFn: async () => ({ acao: 'AGUARDAR', percentual: 0, justificativa: 'T.', valida: true }),
  });

  // 1º ciclo abaixo do chão: recomenda, mas NÃO executa nem fecha a posição.
  const r1 = await rodar(94000);
  assert.equal(r1.tipo, 'stop_loss');
  assert.equal(r1.operacao.status, 'sugerida');
  let [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'real');
  assert.equal(posicao.status !== 'FECHADA', true, 'assistida não fecha a posição sozinha');
  assert.ok(posicao.stop_recomendado_em);

  // 2º ciclo ainda abaixo: não repete a recomendação.
  const r2 = await rodar(93000, r1.estado);
  assert.notEqual(r2.tipo, 'stop_loss');

  // Preço volta acima do chão: o episódio encerra e o flag é limpo.
  await rodar(99000, r2.estado);
  [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'real');
  assert.equal(posicao.stop_recomendado_em, null);
});

test('compra sem stop-loss válido é rejeitada e nenhuma posição é aberta', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  const ativo = await obterAtivo('MB', 'BTC');

  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000, saldoMoeda: 1000 }),
    // Chão ACIMA do preço: o Motor recusa (dispararia na hora).
    decidirFn: async () => ({
      acao: 'COMPRAR',
      percentual: 20,
      stop_loss: 120000,
      stop_loss_motivo: 'inválido',
      justificativa: 'T.',
      valida: true,
    }),
  });

  assert.equal(r.avaliacao.status, 'rejeitada_regras');
  assert.match(r.avaliacao.motivo, /stop-loss/);
  assert.equal((await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao')).length, 0);
});

test('venda por posição fecha o lote com lucro e respeita "nunca vender no prejuízo"', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };

  // 1ª rodada: compra a 100k.
  let ativo = await obterAtivo('MB', 'BTC');
  await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000, saldoMoeda: 1000 }),
    decidirFn: async () => ({ acao: 'COMPRAR', percentual: 50, stop_loss: 95000, stop_loss_motivo: 'suporte', confianca: 80, justificativa: 'T.', valida: true }),
  });
  const [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');

  // 2ª rodada: preço subiu 10% — IA vende a posição; Motor aprova (lucro > taxas).
  ativo = await obterAtivo('MB', 'BTC');
  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 110000, saldoMoeda: 0 }),
    decidirFn: async () => ({
      acao: 'VENDER',
      percentual: 0,
      posicoes: [posicao.id],
      confianca: 80,
      justificativa: 'T.',
      valida: true,
    }),
  });
  assert.equal(r.operacao.status, 'executada');
  assert.equal(r.operacao.tipo, 'VENDA');
  assert.ok(r.operacao.lucro_liquido > 0, `lucro = ${r.operacao.lucro_liquido}`);

  const abertas = (await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao')).filter((p) => p.status !== 'FECHADA');
  assert.equal(abertas.length, 0);

  // 3ª tentativa: preço de volta a 100k — vender de novo daria prejuízo.
  // (nova compra primeiro, para existir posição)
  ativo = await obterAtivo('MB', 'BTC');
  await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000, saldoMoeda: 500 }),
    decidirFn: async () => ({ acao: 'COMPRAR', percentual: 50, stop_loss: 95000, stop_loss_motivo: 'suporte', confianca: 80, justificativa: 'T.', valida: true }),
  });
  const nova = (await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao')).find((p) => p.status !== 'FECHADA');
  ativo = await obterAtivo('MB', 'BTC');
  const rejeicao = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100500, saldoMoeda: 0 }), // +0.5% < taxas
    decidirFn: async () => ({
      acao: 'VENDER',
      percentual: 0,
      posicoes: [nova.id],
      confianca: 80,
      justificativa: 'T.',
      valida: true,
    }),
  });
  assert.equal(rejeicao.avaliacao.status, 'rejeitada_regras');
  assert.match(rejeicao.avaliacao.motivo, /nunca vender no prejuízo/);
});

// A execução REAL registra o lucro pelas taxas EFETIVAS da corretora (o que a
// API respondeu), nunca pelos percentuais superestimados da config. A validação
// pré-ordem do Motor continua na config (garante "nunca vender no prejuízo").
test('venda REAL calcula o lucro com a taxa EFETIVA do fill e a taxa real da compra', async () => {
  const { executar } = await import('../src/executor/executor.js');
  const ativo = await obterAtivo('MB', 'BTC');
  ativo.config.modo_simulacao = false;
  ativo.config.taxa_compra_percentual = 1.5;
  ativo.config.taxa_venda_percentual = 1.5;

  const pos = await abrirPosicao({
    plataforma: 'MB', ativo: 'BTC', modo: 'real', origem: 'bot',
    quantidade: 0.01, preco_compra: 100000, taxa_compra: 7, // taxa de compra REAL (< 1,5%)
  });

  const avaliacao = {
    aprovada: true, aguardar: false, status: 'aprovada', motivo: 'ok',
    ordem: {
      tipo: 'VENDA', quantidade: 0.01,
      posicoes: [{ id: pos.id, quantidade: 0.01, preco_compra: 100000, taxa_compra: 7 }],
      preco_execucao: 110000,
    },
  };
  const decisao = { acao: 'VENDER', percentual: 0, posicoes: [pos.id], justificativa: 'T.', valida: true };
  const conector = {
    id: 'falso',
    ordemMercado: async () => ({ orderId: 'ord-1' }),
    aguardarFill: async () => ({ status: 'filled', preco_medio: 110000, quantidade: 0.01, valor: 1100, taxa: 11 }),
  };

  const op = await executar({ plataformaId: 'MB', ativo, conector, avaliacao, decisao, cenario: { indicadores: {} } });

  assert.equal(op.status, 'executada');
  assert.equal(op.taxa, 11); // taxa EXATA do fill (o que a corretora cobrou)
  // lucro = 1100 − 1000 − 7 (compra real) − 11 (venda real) = 82
  // (com a config seria 1100 − 1000 − 15 − 16,5 = 68,5 — subestimado)
  assert.equal(op.lucro_liquido, 82);
});

test('venda REAL com taxa do fill 0 (trava): venda cai p/ estimativa da config; compra segue real', async () => {
  const { executar } = await import('../src/executor/executor.js');
  const ativo = await obterAtivo('MB', 'BTC');
  ativo.config.modo_simulacao = false;
  ativo.config.taxa_compra_percentual = 1.5;
  ativo.config.taxa_venda_percentual = 1.5;

  const pos = await abrirPosicao({
    plataforma: 'MB', ativo: 'BTC', modo: 'real', origem: 'bot',
    quantidade: 0.01, preco_compra: 100000, taxa_compra: 7,
  });

  const avaliacao = {
    aprovada: true, aguardar: false, status: 'aprovada', motivo: 'ok',
    ordem: {
      tipo: 'VENDA', quantidade: 0.01,
      posicoes: [{ id: pos.id, quantidade: 0.01, preco_compra: 100000, taxa_compra: 7 }],
      preco_execucao: 110000,
    },
  };
  const decisao = { acao: 'VENDER', percentual: 0, posicoes: [pos.id], justificativa: 'T.', valida: true };
  const conector = {
    id: 'falso',
    ordemMercado: async () => ({ orderId: 'ord-2' }),
    aguardarFill: async () => ({ status: 'filled', preco_medio: 110000, quantidade: 0.01, valor: 1100, taxa: 0 }),
  };

  const op = await executar({ plataformaId: 'MB', ativo, conector, avaliacao, decisao, cenario: { indicadores: {} } });

  assert.equal(op.status, 'executada');
  assert.equal(op.taxa, 0); // a API não informou taxa
  // venda cai p/ config (1,5% de 1100 = 16,5); compra segue real (7):
  // lucro = 1100 − 1000 − 7 − 16,5 = 76,5
  assert.equal(op.lucro_liquido, 76.5);
});

test('orçamento por ativo limita a compra ao teto configurado', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  await salvarAtivo('MB', 'BTC', { config: { orcamento_percentual: 10 } }); // teto: 10% do patrimônio
  const ativo = await obterAtivo('MB', 'BTC');

  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000, saldoMoeda: 1000 }),
    decidirFn: async () => ({ acao: 'COMPRAR', percentual: 100, stop_loss: 95000, stop_loss_motivo: 'suporte', confianca: 90, justificativa: 'T.', valida: true }),
  });
  // patrimônio = 1.000 (sem ativos) → teto 100 → 100% do livre = R$ 100.
  assert.equal(r.operacao.status, 'executada');
  assert.equal(r.operacao.valor, 100);
});

test('2ª execução dentro do intervalo e variação abaixo do filtro não chama a IA', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  let chamadas = 0;
  const decidirFalso = async () => {
    chamadas += 1;
    return { acao: 'AGUARDAR', percentual: 0, confianca: 50, justificativa: 'T.', valida: true };
  };

  let ativo = await obterAtivo('MB', 'BTC');
  await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000 }),
    decidirFn: decidirFalso,
  });
  assert.equal(chamadas, 1);

  // Preço variou só 0,1% (< 0,3%): a IA NÃO é chamada; vira "verificacao".
  ativo = await obterAtivo('MB', 'BTC');
  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100100 }),
    decidirFn: decidirFalso,
  });
  assert.equal(r.tipo, 'sem_variacao');
  assert.equal(chamadas, 1);

  // (os dois registros podem cair no mesmo milissegundo em teste — basta
  // existir a entrada de verificação sem chamada à IA)
  const historico = await obterHistoricoRecenteAtivo('MB', 'BTC', 5);
  const verificacao = historico.find((h) => h.tipo === 'verificacao');
  assert.ok(verificacao);
  assert.equal(verificacao.chamou_ia, false);
});

test('ciclo usa o estado injetado (não relê) e devolve o estado atualizado (V5.2)', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  const aguardar = async () => ({ acao: 'AGUARDAR', percentual: 0, confianca: 50, justificativa: 'T.', valida: true });
  const base = { plataforma, api: { api_key_ia: 'x' } };

  let ativo = await obterAtivo('MB', 'BTC');
  const r1 = await executarCicloAtivo({
    ...base,
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000 }),
    decidirFn: aguardar,
  });
  assert.equal(r1.tipo, 'analise');
  assert.equal(r1.estado.preco_ultima_analise, 100000); // baseline devolvido a quem chamou

  // Variação de 0,1% (< 0,3%): com o estado DEVOLVIDO pelo 1º ciclo, o filtro vale…
  ativo = await obterAtivo('MB', 'BTC');
  const r2 = await executarCicloAtivo({
    ...base,
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100100 }),
    estado: r1.estado,
    decidirFn: aguardar,
  });
  assert.equal(r2.tipo, 'sem_variacao');
  assert.ok(r2.estado.horario_ultima_verificacao); // estado atualizado também na verificação

  // …e com um estado injetado SEM baseline, o ciclo confia nele (não relê o
  // Firestore, que tem baseline persistido) e faz a análise completa.
  ativo = await obterAtivo('MB', 'BTC');
  const r3 = await executarCicloAtivo({
    ...base,
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100100 }),
    estado: { ...r1.estado, preco_ultima_analise: null },
    decidirFn: aguardar,
  });
  assert.equal(r3.tipo, 'analise');
});

test('última operação executada vive no estado: automigração + atualização após ordem (V5.2)', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  const aguardar = async () => ({ acao: 'AGUARDAR', percentual: 0, confianca: 50, justificativa: 'T.', valida: true });

  // Estado de ANTES da V5.2 (sem o campo) + operação antiga na coleção:
  // o primeiro ciclo busca pela query antiga UMA vez e persiste o resumo.
  await registrarOperacaoAtivo('MB', 'BTC', {
    id: 'op_20260701_000000',
    tipo: 'COMPRA',
    status: 'executada',
    horario: '2026-07-01T00:00:00Z',
  });
  let ativo = await obterAtivo('MB', 'BTC');
  const r1 = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000 }),
    decidirFn: aguardar,
  });
  assert.equal(r1.cenario.historico_resumido.ultima_operacao, 'COMPRA');
  const migrado = await obterEstadoAtivo('MB', 'BTC');
  assert.equal(migrado.ultima_operacao_executada.id, 'op_20260701_000000');

  // Ordem nova executada → o resumo do estado (e o devolvido) acompanham.
  ativo = await obterAtivo('MB', 'BTC');
  const r2 = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 110000, saldoMoeda: 1000 }),
    estado: r1.estado,
    decidirFn: async () => ({ acao: 'COMPRAR', percentual: 20, stop_loss: 105000, stop_loss_motivo: 'suporte', confianca: 80, justificativa: 'T.', valida: true }),
  });
  assert.equal(r2.operacao.status, 'executada');
  assert.equal(r2.estado.ultima_operacao_executada.id, r2.operacao.id);
  assert.equal((await obterEstadoAtivo('MB', 'BTC')).ultima_operacao_executada.id, r2.operacao.id);
});

test('executarRodada ignora ativos desligados e plataformas sem conector utilizável', async () => {
  // ETH/SOL estão desligados; BTC ligado mas o conector 'mb' real falharia —
  // aqui o teste é do FILTRO: com todos os ativos desligados, nada roda.
  await salvarAtivo('MB', 'BTC', { config: { ativo: false } });
  const resumo = await executarRodada({ decidirFn: async () => ({}) });
  assert.deepEqual(resumo, []);
});

test('montarStatusBot: heartbeat com instância "todas" (bot único) e campos esperados', () => {
  const original = process.env.BOT_PLATAFORMAS;
  delete process.env.BOT_PLATAFORMAS; // bot único → instancia "todas", primário
  try {
    const agora = new Date('2026-07-18T21:00:00Z');
    const s = montarStatusBot({ agora, ultimaRodada: 'MB/BTC:analise' });
    assert.equal(s.atualizado_em, '2026-07-18T21:00:00.000Z');
    assert.equal(s.instancia, 'todas');
    assert.equal(s.primario, true);
    assert.equal(s.ultima_rodada, 'MB/BTC:analise');
    assert.ok(s.iniciado_em); // momento de boot do processo
    assert.equal(s.travado, false); // parada de emergência desligada por padrão (V6.2)
    assert.equal(montarStatusBot({ agora, travado: true }).travado, true);
  } finally {
    if (original === undefined) delete process.env.BOT_PLATAFORMAS;
    else process.env.BOT_PLATAFORMAS = original;
  }
});

test('montarStatusBot: instância escopada reflete BOT_PLATAFORMAS', () => {
  const original = process.env.BOT_PLATAFORMAS;
  process.env.BOT_PLATAFORMAS = 'BN,TT';
  try {
    const s = montarStatusBot({ agora: new Date('2026-07-18T21:00:00Z') });
    assert.equal(s.instancia, 'BN,TT');
    assert.equal(s.ultima_rodada, null); // padrão quando nada rodou ainda
  } finally {
    if (original === undefined) delete process.env.BOT_PLATAFORMAS;
    else process.env.BOT_PLATAFORMAS = original;
  }
});

test('salvarStatusBot + obterStatusBot faz round-trip do heartbeat', async () => {
  assert.equal(await obterStatusBot(), null); // nunca gravado
  await salvarStatusBot(montarStatusBot({ agora: new Date('2026-07-18T21:00:00Z') }));
  const lido = await obterStatusBot();
  assert.equal(lido.atualizado_em, '2026-07-18T21:00:00.000Z');
  assert.ok(lido.iniciado_em);
});

test('parada de emergência (V6.2): controle começa nulo e faz round-trip', async () => {
  assert.equal(await obterControle(), null); // botão nunca usado
  await salvarControle({ operacao_travada: true, travado_em: '2026-07-19T10:00:00Z' });
  assert.equal((await obterControle()).operacao_travada, true);
  await salvarControle({ operacao_travada: false });
  assert.equal((await obterControle()).operacao_travada, false);
});

test('estado em memória: a marca do reset descarta a cópia, e nada mais descarta', () => {
  // O bot lê `dados/estado` de cada ativo UMA vez por boot e depois vive de uma
  // cópia em RAM. O reset apaga esses documentos por fora, e sem uma marca o
  // processo continua filtrando a variação contra o preço pré-reset e
  // regravando os contadores de decisão antigos nos documentos novos — foi o
  // que aconteceu em 2026-07-27, contaminando a primeira medição da janela.

  // PRIMEIRO tick do processo (nada visto ainda): só anota, nunca limpa. Limpar
  // aqui custaria uma releitura por ativo a cada reinício, sem motivo — o boot
  // acabou de ler o estado fresco.
  assert.equal(deveLimparEstadoEmMemoria(null, undefined), false);
  assert.equal(deveLimparEstadoEmMemoria('2026-07-27T17:25:00Z', undefined), false);

  // Marca NOVA em relação à vista no tick anterior: descarta.
  assert.equal(deveLimparEstadoEmMemoria('2026-07-27T17:25:00Z', null), true);
  assert.equal(deveLimparEstadoEmMemoria('2026-08-02T03:00:00Z', '2026-07-27T17:25:00Z'), true);

  // Marca IGUAL: o tick normal não pode jogar o estado fora. Se jogasse, cada
  // um dos 1.440 ticks do dia pagaria uma leitura por ativo — o oposto do
  // invariante de leituras da V5.2.
  assert.equal(deveLimparEstadoEmMemoria('2026-07-27T17:25:00Z', '2026-07-27T17:25:00Z'), false);
  assert.equal(deveLimparEstadoEmMemoria(null, null), false);

  // Campo ausente (`undefined` no doc) e `null` são o MESMO "sem marca": o
  // `global/controle` de quem nunca rodou um reset não pode parecer mudança.
  assert.equal(deveLimparEstadoEmMemoria(undefined, null), false);
  assert.equal(deveLimparEstadoEmMemoria(null, undefined), false);
});

test('validade do contexto (V6.2): a IA a define UMA vez e o contexto não é mais perguntado', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const conector = conectorFalso({ preco: 100000, saldoMoeda: 1000 });
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  const ativo = await obterAtivo('MB', 'BTC');
  await salvarContextoAtivo('MB', 'BTC', 'Notícia relevante de curto prazo.');
  invalidarCatalogo();

  // 1ª análise: o prompt pede validade e a IA devolve 10 dias.
  let promptRecebido = '';
  const decidirComValidade = async (cenario, opcoes) => {
    promptRecebido = opcoes.promptSistema;
    return { acao: 'AGUARDAR', percentual: 0, justificativa: 'Sem sinal.', valida: true, validade_contexto_dias: 10 };
  };
  await executarCicloAtivo({
    plataforma, api: { api_key_ia: 'x' }, ativo, ativosDaPlataforma: [ativo],
    conector, decidirFn: decidirComValidade,
  });
  assert.match(promptRecebido, /validade_contexto_dias/); // pediu na 1ª
  const ctx = await obterContextoAtivo('MB', 'BTC');
  assert.ok(ctx.validade_ate && ctx.validade_definida_em);
  // validade = momento da análise + 10 dias (cicloAtivo usa a hora real).
  assert.equal(
    new Date(ctx.validade_ate).getTime() - new Date(ctx.validade_definida_em).getTime(),
    10 * 86_400_000,
  );

  // 2ª análise: já tem validade → NÃO pede de novo, mas o contexto ainda entra.
  invalidarCatalogo(); // cicloAtivo já invalidou, mas garante leitura fresca
  let prompt2 = '';
  const decidir2 = async (cenario, opcoes) => {
    prompt2 = opcoes.promptSistema;
    return { acao: 'AGUARDAR', percentual: 0, justificativa: 'Sem sinal.', valida: true };
  };
  // força variação para chamar a IA de novo
  await executarCicloAtivo({
    plataforma, api: { api_key_ia: 'x' }, ativo,
    ativosDaPlataforma: [ativo], conector: conectorFalso({ preco: 110000, saldoMoeda: 1000 }),
    decidirFn: decidir2,
  });
  assert.doesNotMatch(prompt2, /validade_contexto_dias/); // não pede mais
  assert.match(prompt2, /Notícia relevante de curto prazo/); // mas ainda envia o contexto
});

test('executarRodada respeita BOT_PLATAFORMAS (escopo por instância)', async () => {
  // BTC está LIGADO por padrão. Com o escopo excluindo MB, a plataforma nem é
  // percorrida — nenhum conector do MB é construído nem consultado (sem rede) e
  // a rodada volta vazia. (Se o filtro falhasse, o MB rodaria o ciclo real.)
  const original = process.env.BOT_PLATAFORMAS;
  process.env.BOT_PLATAFORMAS = 'BN'; // só MB existe no seed → nada roda
  try {
    const resumo = await executarRodada({ decidirFn: async () => ({}) });
    assert.deepEqual(resumo, []);
  } finally {
    if (original === undefined) delete process.env.BOT_PLATAFORMAS;
    else process.env.BOT_PLATAFORMAS = original;
  }
});

test('regras gerais, prompt e contexto do ativo entram no prompt final do ciclo', async () => {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const { garantirRegrasGerais } = await import('../src/migracao/migrarV1paraV2.js');
  const { salvarRegrasGerais, obterRegrasGerais } = await import('../src/firebase/firebaseClient.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };

  // Semeadura: grava a partir do arquivo e nunca sobrescreve edições.
  assert.equal((await garantirRegrasGerais()).semeado, true);
  assert.equal((await garantirRegrasGerais()).semeado, false);
  await salvarRegrasGerais('# Regras gerais editadas\n\nRegra editada pelo Rodrigo.');
  assert.equal((await obterRegrasGerais()).versao, 2); // semente = v1, edição = v2

  await salvarPromptAtivo('MB', 'BTC', 'Instrução especial do BTC.');
  await salvarContextoAtivo('MB', 'BTC', 'Notícia importante de hoje.');
  const ativo = await obterAtivo('MB', 'BTC');

  let promptVisto = null;
  await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'x' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco: 100000 }),
    decidirFn: async (cenario, opcoes) => {
      promptVisto = opcoes.promptSistema;
      return { acao: 'AGUARDAR', percentual: 0, confianca: 50, justificativa: 'T.', valida: true };
    },
  });
  assert.match(promptVisto, /Regra editada pelo Rodrigo\./);
  assert.match(promptVisto, /Instrução especial do BTC\./);
  assert.match(promptVisto, /Notícia importante de hoje\./);
  // regras gerais vêm ANTES de tudo
  assert.ok(promptVisto.indexOf('Regra editada') < promptVisto.indexOf('Instrução especial'));
});
