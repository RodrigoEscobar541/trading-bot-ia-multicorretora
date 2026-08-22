// orcamentos.test.js — a soma dos orçamentos da tela ⚙ Parâmetros
// (`dashboard/public/orcamentos.js`, V8.16).
//
// Por que este arquivo existe: o aviso vermelho de "passou de 100%" é a única
// conta da dashboard que decide algo visível, e ele SUMIU quando o formulário
// por ativo virou tabela. Módulo puro, sem DOM e sem Firebase — a tela só
// desenha o que ele devolve. Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { somarOrcamentos, textoOrcamento, TETO_ORCAMENTO } from '../dashboard/public/orcamentos.js';

/** Monta o Map que a dashboard mantém: pid → { dados, ativos: Map }. */
function montar(plataformas) {
  return new Map(
    Object.entries(plataformas).map(([pid, { nome, ativos }]) => [
      pid,
      {
        dados: { nome },
        ativos: new Map(
          Object.entries(ativos).map(([aid, config]) => [aid, { config }]),
        ),
      },
    ]),
  );
}

const REAL = { modo_simulacao: false };
const SIM = { modo_simulacao: true };

test('separa a conta por MODO: simulação e real dividem 100% cada um', () => {
  // O caso da Binance que motivou a separação (V8.14): somados, os cinco ativos
  // dão 205% e o aviso pediria um reequilíbrio que não existe — os reais somam
  // exatamente os 100% certos.
  const linhas = somarOrcamentos({
    plataformas: montar({
      BN: {
        nome: 'Binance',
        ativos: {
          BNB: { ...REAL, orcamento_percentual: 50 },
          SOL: { ...REAL, orcamento_percentual: 50 },
          BTC: { ...SIM, orcamento_percentual: 80 },
          ETH: { ...SIM, orcamento_percentual: 5 },
          XRP: { ...SIM, orcamento_percentual: 20 },
        },
      },
    }),
  });

  assert.equal(linhas.length, 2);
  const [real, simulacao] = linhas;
  assert.equal(real.modo, 'real', 'o modo real vem primeiro');
  assert.equal(real.total, 100);
  assert.equal(real.quantos, 2);
  assert.equal(real.excedeu, false, '100% exatos NÃO é estouro');

  assert.equal(simulacao.modo, 'simulacao');
  assert.equal(simulacao.total, 105);
  assert.equal(simulacao.excedeu, true);
  assert.deepEqual(simulacao.ativos.sort(), ['BTC', 'ETH', 'XRP']);
});

test('só o grupo que passou de 100% é marcado — o outro não é contaminado', () => {
  const [real, simulacao] = somarOrcamentos({
    plataformas: montar({
      MB: {
        nome: 'Mercado Bitcoin',
        ativos: {
          BTC: { ...REAL, orcamento_percentual: 120 },
          ETH: { ...SIM, orcamento_percentual: 10 },
        },
      },
    }),
  });
  assert.equal(real.excedeu, true);
  assert.deepEqual(real.ativos, ['BTC']);
  assert.equal(simulacao.excedeu, false);
  assert.deepEqual(simulacao.ativos, ['ETH']);
});

test('o valor sendo DIGITADO entra na conta antes de salvar', () => {
  const plataformas = montar({
    BN: { nome: 'Binance', ativos: { BNB: { ...REAL, orcamento_percentual: 50 }, SOL: { ...REAL, orcamento_percentual: 50 } } },
  });
  const semEdicao = somarOrcamentos({ plataformas })[0];
  assert.equal(semEdicao.total, 100);
  assert.equal(semEdicao.excedeu, false);

  // O dono digita 70 no SOL: o vermelho tem de acender ANTES de salvar.
  const comEdicao = somarOrcamentos({
    plataformas,
    valorEditado: (pid, aid, coluna, salvo) =>
      (aid === 'SOL' && coluna === 'orcamento_percentual' ? 70 : salvo),
  })[0];
  assert.equal(comEdicao.total, 120);
  assert.equal(comEdicao.excedeu, true);
});

test('marcar "Simulação" MOVE o ativo de grupo na hora, e os dois totais mudam', () => {
  // É o caso que mais engana: o ativo sai de um grupo e entra no outro, então o
  // aviso pode acender de um lado e apagar do outro no mesmo clique.
  const plataformas = montar({
    BN: {
      nome: 'Binance',
      ativos: {
        BNB: { ...REAL, orcamento_percentual: 60 },
        SOL: { ...REAL, orcamento_percentual: 60 },
        BTC: { ...SIM, orcamento_percentual: 10 },
      },
    },
  });

  const antes = somarOrcamentos({ plataformas });
  assert.equal(antes.find((l) => l.modo === 'real').total, 120);
  assert.equal(antes.find((l) => l.modo === 'real').excedeu, true);

  const depois = somarOrcamentos({
    plataformas,
    valorEditado: (pid, aid, coluna, salvo) =>
      (aid === 'SOL' && coluna === 'modo_simulacao' ? true : salvo),
  });
  const real = depois.find((l) => l.modo === 'real');
  const simulacao = depois.find((l) => l.modo === 'simulacao');
  assert.equal(real.total, 60, 'o real perdeu o ativo movido');
  assert.equal(real.excedeu, false);
  assert.equal(simulacao.total, 70, 'e a simulação ganhou');
  assert.deepEqual(simulacao.ativos.sort(), ['BTC', 'SOL']);
});

test('campo vazio conta como 0 — o total nunca vira NaN na tela', () => {
  const [linha] = somarOrcamentos({
    plataformas: montar({ BN: { nome: 'Binance', ativos: { BNB: { ...REAL, orcamento_percentual: 40 } } } }),
    valorEditado: (pid, aid, coluna, salvo) =>
      (coluna === 'orcamento_percentual' ? Number('') || NaN : salvo),
  });
  assert.equal(linha.total, 0);
  assert.equal(linha.excedeu, false);
});

test('ativo sem orçamento definido entra como 0, e plataforma vazia não vira linha', () => {
  const linhas = somarOrcamentos({
    plataformas: montar({
      MB: { nome: 'Mercado Bitcoin', ativos: { BTC: { ...REAL } } },
      TORO: { nome: 'Toro', ativos: {} },
    }),
  });
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].total, 0);
  assert.equal(linhas[0].pid, 'MB');
});

test('o texto diz o número, o grupo e o que fazer', () => {
  const [linha] = somarOrcamentos({
    plataformas: montar({ BN: { nome: 'Binance', ativos: { BNB: { ...REAL, orcamento_percentual: 130 } } } }),
  });
  const texto = textoOrcamento(linha);
  assert.match(texto, /Binance/);
  assert.match(texto, /MODO REAL/);
  assert.match(texto, /1 ativo/);
  assert.match(texto, /130%/);
  assert.match(texto, /ACIMA DE 100%/);
  assert.match(texto, /reequilibre/);

  const [ok] = somarOrcamentos({
    plataformas: montar({ BN: { nome: 'Binance', ativos: { BNB: { ...SIM, orcamento_percentual: 30 }, BTC: { ...SIM, orcamento_percentual: 20 } } } }),
  });
  assert.equal(textoOrcamento(ok), 'Binance · SIMULAÇÃO (2 ativos): 50% de 100%');
});

test('o teto é 100 e a soma arredonda em 2 casas (centésimo não acende o vermelho)', () => {
  assert.equal(TETO_ORCAMENTO, 100);
  const [linha] = somarOrcamentos({
    plataformas: montar({
      BN: { nome: 'Binance', ativos: { A: { ...REAL, orcamento_percentual: 33.333 }, B: { ...REAL, orcamento_percentual: 66.666 } } },
    }),
  });
  assert.equal(linha.total, 100);
  assert.equal(linha.excedeu, false);
});
