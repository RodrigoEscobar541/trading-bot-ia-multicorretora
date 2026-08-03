// camposDeMedicao.test.js — o CONTRATO entre quem ESCREVE e quem MEDE.
//
// Por que este arquivo existe (V8.3): em 2026-07-25 descobriu-se que
// `stop_loss_inicial` não existia em NENHUM dos 23 lotes fechados em produção.
// A métrica de risco:retorno lia esse campo, devolvia null para 100% da amostra
// e reportava "sem amostra" — que parecia falta de operações, não falta de
// campo. O defeito passou semanas invisível porque nada ligava quem grava a
// posição a quem lê os números depois.
//
// A ideia aqui é simples: para cada consumidor de métrica, uma LISTA dos campos
// que ele lê; e a prova de que uma posição/operação recém-criada pelo código de
// verdade os tem. Campo ausente reprova. Campo `null` é aceito quando o dado
// legitimamente não existe ainda (posição aberta não tem preço de venda) —
// ausente NUNCA é aceito, porque `undefined` some no JSON e a métrica cega.
//
// AO ADICIONAR UMA MÉTRICA NOVA: acrescente o campo na lista do consumidor. Se
// o teste quebrar, é porque ninguém está gravando o campo — que é exatamente o
// aviso que faltou da primeira vez. Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { abrirPosicao, fecharPosicao } from '../src/posicoes/posicoes.js';
import {
  inicializarPersistencia,
  registrarOperacaoAtivo,
  obterPosicaoAtivo,
  obterOperacoesDesdeAtivo,
} from '../src/firebase/firebaseClient.js';
import {
  razaoRiscoRetorno,
  assimetriaRealizada,
  resumirOperacoes,
  capturaDoPico,
} from '../src/nucleo/relatorioDecisoes.js';
import { avaliarPicoPosicoes } from '../src/regras/regrasEngine.js';

const ESCOPO = { plataforma: 'MB', ativo: 'BTC' };

// ------------------------------------------------------------- os contratos

/**
 * Campos de uma POSIÇÃO lidos por quem mede. Cada um traz quem o consome —
 * apagar um campo daqui sem apagar o consumidor é o erro que este arquivo pega.
 */
const CAMPOS_POSICAO = {
  // relatorioDecisoes.razaoRiscoRetorno
  preco_compra: 'R:R e assimetria',
  quantidade: 'R:R',
  stop_loss_inicial: 'R:R — o campo que faltou em 2026-07-25',
  lucro_liquido: 'R:R, assimetria, fechamentos (null enquanto aberta)',
  // relatorioDecisoes.resumirOperacoes
  fechada_por: 'contagem de fechamentos por motivo (null enquanto aberta)',
  // supervisor.resumirPosicao — o retrato semanal
  id: 'supervisor identifica o lote',
  origem: 'supervisor separa lote do bot de compra externa/manual',
  status: 'supervisor e Motor',
  abertura: 'supervisor data o lote (NÃO existe `aberta_em` no doc)',
  stop_loss: 'supervisor e checagem de stop do Motor',
  stop_loss_atualizado_em: 'supervisor distingue chão parado de trailing já agiu',
  stop_loss_motivo: 'supervisor e auditoria da venda por stop',
  lucro_se_vender_agora: 'supervisor — havia lote em lucro sendo ignorado?',
  // relatorioDecisoes.capturaDoPico (V8.5)
  preco_maximo: 'captura do pico — quanto o lote CHEGOU a render (nunca null)',
  preco_maximo_em: 'quando o pico aconteceu — separa saída rápida de lenta',
  // regrasEngine
  stop_loss_trailing_percentual: 'trailing do Motor (null = usa a config)',
  taxa_compra: 'breakeven pela taxa EFETIVA (§10.4)',
  aberta_modo: 'query das posições abertas (invariante V5.2)',
};

/** Campos que só existem depois do fechamento — antes disso são null. */
const CAMPOS_POSICAO_FECHADA = {
  fechamento: 'linha do tempo dos fechamentos',
  preco_venda: 'auditoria da saída',
  taxa_venda: 'lucro realizado',
  lucro_liquido: 'R:R e assimetria — sem ele o lote não entra em métrica nenhuma',
  fechada_por: 'separa realização da IA de stop do Motor',
};

/** Campos de uma OPERAÇÃO lidos por quem mede. */
const CAMPOS_OPERACAO = {
  tipo: 'resumirOperacoes separa compra de venda',
  status: 'resumirOperacoes conta executada/rejeitada/erro',
  horario: 'janela do relatório e linha do tempo do supervisor',
  taxa: 'taxas pagas × lucro realizado (o teste de giro caro)',
  valor: 'volume',
  lucro_liquido: 'lucro realizado da janela',
  posicoes: 'liga a venda aos lotes que ela fechou',
  origem_decisao: 'separa IA, stop do Motor e liquidação (V8)',
  preco: 'supervisor separa stop mal calibrado de GAP de abertura',
  modo: 'simulação nunca se mistura com real',
};

const presente = (obj, campo) => Object.prototype.hasOwnProperty.call(obj, campo);

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
});

// --------------------------------------------------------------- os testes

test('posição recém-aberta tem TODOS os campos que as métricas leem', async () => {
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01,
    preco_compra: 340000,
    valor: 3400,
    taxa_compra: 23.8,
    modo: 'simulacao',
    stop_loss: 320000,
    stop_loss_motivo: 'abaixo do fundo recente',
    stop_loss_trailing_percentual: 3,
  });

  for (const [campo, quem] of Object.entries(CAMPOS_POSICAO)) {
    assert.ok(presente(pos, campo), `posição nasce SEM \`${campo}\` — usado por: ${quem}`);
  }
  // O campo que originou este arquivo precisa ser NÚMERO, não só presente:
  // gravar null aqui devolveria a métrica ao estado cego de 2026-07-25.
  assert.equal(typeof pos.stop_loss_inicial, 'number');
  assert.equal(pos.stop_loss_inicial, 320000);
  // Mesma exigência para o pico (V8.5): null aqui repetiria o erro de 2026-07-25
  // num campo novo. O lote nasce com o pico no próprio preço de entrada.
  assert.equal(typeof pos.preco_maximo, 'number');
  assert.equal(pos.preco_maximo, 340000);
});

test('o PICO sobe com o preço e nunca desce', async () => {
  // A metade que falta para julgar a saída padrão (§10.2.1): sem o pico, o lote
  // fechado diz quanto rendeu e nunca quanto CHEGOU a render.
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01, preco_compra: 340000, valor: 3400, modo: 'simulacao', stop_loss: 320000,
  });
  const { registrarPico } = await import('../src/posicoes/posicoes.js');

  // Máxima nova: o Motor manda gravar.
  const subiu = avaliarPicoPosicoes({ posicoes_abertas: [pos], preco_atual: 360000 });
  assert.equal(subiu.aplicar.length, 1);
  assert.equal(subiu.aplicar[0].preco_maximo, 360000);
  await registrarPico(ESCOPO.plataforma, ESCOPO.ativo, pos.id, { preco: 360000 });

  const depois = await obterPosicaoAtivo(ESCOPO.plataforma, ESCOPO.ativo, pos.id);
  assert.equal(depois.preco_maximo, 360000);

  // Preço recuando NÃO mexe no pico — é o retrato do melhor momento, não do agora.
  assert.equal(avaliarPicoPosicoes({ posicoes_abertas: [depois], preco_atual: 345000 }).aplicar.length, 0);
  // Nem centavo acima do pico: o Motor roda todo ciclo e isso seria uma escrita
  // por posição por tick, sem ganho nenhum de medição.
  assert.equal(avaliarPicoPosicoes({ posicoes_abertas: [depois], preco_atual: 360100 }).aplicar.length, 0);
});

test('captura do pico: o lote fechado responde quanto do avanço a saída levou', async () => {
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01, preco_compra: 100, valor: 1, modo: 'simulacao', stop_loss: 90,
  });
  const { registrarPico } = await import('../src/posicoes/posicoes.js');
  await registrarPico(ESCOPO.plataforma, ESCOPO.ativo, pos.id, { preco: 110 }); // subiu 10%
  await fecharPosicao(ESCOPO.plataforma, ESCOPO.ativo, pos.id, {
    preco_venda: 107, lucro_liquido: 5, fechada_por: 'stop_loss', // saiu com 7%
  });
  const fechada = await obterPosicaoAtivo(ESCOPO.plataforma, ESCOPO.ativo, pos.id);

  const c = capturaDoPico(fechada);
  assert.ok(c !== null, 'capturaDoPico devolveu null num lote fechado pelo código atual');
  assert.ok(Math.abs(c.avanco_maximo - 10) < 1e-9);
  assert.ok(Math.abs(c.avanco_capturado - 7) < 1e-9);
  assert.ok(Math.abs(c.captura - 0.7) < 1e-9, `captura=${c.captura}`);
});

test('lote que nunca subiu fica FORA da captura, em vez de virar zero', async () => {
  // Sem avanço não existe proporção a medir. Contá-lo como 0% de captura
  // afundaria a mediana e faria o trailing parecer largo sem nenhuma evidência.
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01, preco_compra: 100, valor: 1, modo: 'simulacao', stop_loss: 90,
  });
  await fecharPosicao(ESCOPO.plataforma, ESCOPO.ativo, pos.id, {
    preco_venda: 92, lucro_liquido: -8, fechada_por: 'stop_loss',
  });
  const fechada = await obterPosicaoAtivo(ESCOPO.plataforma, ESCOPO.ativo, pos.id);
  assert.equal(capturaDoPico(fechada), null);
});

test('o chão INICIAL não se move quando o trailing sobe o chão atual', async () => {
  // É a razão de o campo existir: `stop_loss` sobe, e no fechamento já não diz
  // qual risco foi aceito na entrada. Se os dois andassem juntos, o R:R mediria
  // o risco do último instante, não o da decisão — e daria sempre ~0.
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01, preco_compra: 340000, valor: 3400, modo: 'simulacao', stop_loss: 320000,
  });
  const { definirStopLoss } = await import('../src/posicoes/posicoes.js');
  await definirStopLoss(ESCOPO.plataforma, ESCOPO.ativo, pos.id, { stop_loss: 335000, motivo: 'trailing' });

  const depois = await obterPosicaoAtivo(ESCOPO.plataforma, ESCOPO.ativo, pos.id);
  assert.equal(depois.stop_loss, 335000, 'o chão atual subiu');
  assert.equal(depois.stop_loss_inicial, 320000, 'o chão INICIAL ficou onde estava');
});

test('posição fechada tem os campos do fechamento e ENTRA nas métricas', async () => {
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01, preco_compra: 340000, valor: 3400, taxa_compra: 23.8,
    modo: 'simulacao', stop_loss: 320000, stop_loss_motivo: 'fundo',
  });
  await fecharPosicao(ESCOPO.plataforma, ESCOPO.ativo, pos.id, {
    preco_venda: 350000, taxa_venda: 24.5, lucro_liquido: 51.7, fechada_por: 'lucro',
  });
  const fechada = await obterPosicaoAtivo(ESCOPO.plataforma, ESCOPO.ativo, pos.id);

  for (const [campo, quem] of Object.entries(CAMPOS_POSICAO_FECHADA)) {
    assert.ok(presente(fechada, campo), `posição fechada SEM \`${campo}\` — usado por: ${quem}`);
  }

  // O TESTE QUE TERIA PEGO O DEFEITO: a métrica precisa devolver número, não null.
  const rr = razaoRiscoRetorno(fechada);
  assert.ok(rr !== null, 'razaoRiscoRetorno devolveu null num lote fechado pelo código atual');
  // risco = (340000 − 320000) × 0,01 = 200; retorno 51,70 → ~0,26×
  assert.ok(Math.abs(rr.risco - 200) < 1e-9, `risco=${rr.risco}`);
  assert.ok(Math.abs(rr.razao - 0.2585) < 1e-4, `razao=${rr.razao}`);

  const a = assimetriaRealizada([fechada.lucro_liquido]);
  assert.equal(a.n, 1);
  assert.equal(a.ganhos, 1);
});

test('operação registrada tem TODOS os campos que o relatório lê', async () => {
  await registrarOperacaoAtivo(ESCOPO.plataforma, ESCOPO.ativo, {
    id: 'op_20260726_120000',
    plataforma: ESCOPO.plataforma,
    ativo: ESCOPO.ativo,
    tipo: 'VENDA',
    status: 'executada',
    horario: '2026-07-26T12:00:00Z',
    preco: 350000,
    quantidade: 0.01,
    valor: 3500,
    taxa: 24.5,
    lucro_liquido: 51.7,
    posicoes: ['pos_x'],
    origem_decisao: 'ia',
    modo: 'simulacao',
  });

  const [op] = await obterOperacoesDesdeAtivo(ESCOPO.plataforma, ESCOPO.ativo, '2026-01-01T00:00:00Z');
  for (const [campo, quem] of Object.entries(CAMPOS_OPERACAO)) {
    assert.ok(presente(op, campo), `operação SEM \`${campo}\` — usado por: ${quem}`);
  }

  const r = resumirOperacoes({
    operacoes: [op],
    posicoesPorId: new Map([['pos_x', { lucro_liquido: 51.7, fechada_por: 'lucro' }]]),
    moeda: 'BRL',
  });
  assert.equal(r.vendas, 1);
  assert.equal(r.lucro_realizado, 51.7);
  assert.equal(r.taxas_pagas, 24.5);
  assert.equal(r.fechamentos.lucro.n, 1);
});

test('o retrato do supervisor lê os campos pelos nomes REAIS do doc', async () => {
  // O erro clássico já cometido: ler `aberta_em` num doc cujo campo é `abertura`
  // (corrigido em 2026-07-25). O nome errado não quebra nada — devolve null, e
  // o agente conclui em cima de dado faltando.
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01, preco_compra: 340000, valor: 3400, modo: 'simulacao',
    stop_loss: 320000, stop_loss_motivo: 'fundo',
  });
  assert.ok(presente(pos, 'abertura'), 'o campo da data de abertura chama `abertura`');
  assert.ok(!presente(pos, 'aberta_em'), 'não existe `aberta_em` no doc — quem ler assim recebe null');

  const { coletarRetrato } = await import('../src/nucleo/supervisor.js');
  assert.equal(typeof coletarRetrato, 'function');

  // Os nomes que o retrato entrega ao supervisor, conferidos contra o doc real.
  const deParaDoRetrato = {
    aberta_em: 'abertura',
    lucro_liquido_se_vender_agora: 'lucro_se_vender_agora',
    stop_loss_inicial: 'stop_loss_inicial',
    stop_loss_atualizado_em: 'stop_loss_atualizado_em',
  };
  for (const [nomeNoRetrato, nomeNoDoc] of Object.entries(deParaDoRetrato)) {
    assert.ok(presente(pos, nomeNoDoc), `o retrato promete \`${nomeNoRetrato}\`, que vem de \`${nomeNoDoc}\` — e o doc não tem esse campo`);
  }
});

test('posição SEM chão (externa/manual) fica fora do R:R, sem quebrar nada', async () => {
  // Compra do dono por fora: não há risco declarado, então não há R:R possível.
  // A métrica precisa DESCARTAR o lote, nunca inventar um número para ele.
  const pos = await abrirPosicao({
    ...ESCOPO,
    quantidade: 0.01, preco_compra: 340000, valor: 3400, modo: 'simulacao', origem: 'externa',
  });
  assert.ok(presente(pos, 'stop_loss_inicial'), 'o campo existe mesmo sem chão');
  assert.equal(pos.stop_loss_inicial, null, 'e vale null, não um número inventado');

  await fecharPosicao(ESCOPO.plataforma, ESCOPO.ativo, pos.id, {
    preco_venda: 350000, lucro_liquido: 51.7, fechada_por: 'lucro',
  });
  const fechada = await obterPosicaoAtivo(ESCOPO.plataforma, ESCOPO.ativo, pos.id);
  assert.equal(razaoRiscoRetorno(fechada), null);
  // Mas ela CONTINUA entrando na assimetria, que só precisa do lucro.
  assert.equal(assimetriaRealizada([fechada.lucro_liquido]).n, 1);
});
