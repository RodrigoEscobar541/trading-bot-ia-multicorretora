// patrimonio.test.js — o total consolidado da Visão geral
// (`dashboard/public/patrimonio.js`, V8.17).
//
// Este arquivo existe porque a conta viveu meses errada solta dentro do
// `app.js`, onde nada a alcançava: ela somava carteira VIRTUAL ao patrimônio e
// perdia o caixa de duas das três plataformas em BRL. Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { consolidarPatrimonio } from '../dashboard/public/patrimonio.js';

/** Monta o Map que a dashboard mantém, no formato que o módulo consome. */
function montar(plataformas) {
  return new Map(
    Object.entries(plataformas).map(([pid, { moeda, ativos }]) => [
      pid,
      {
        dados: { moeda },
        ativos: new Map(Object.keys(ativos).map((aid) => [aid, {}])),
        porAtivo: new Map(
          Object.entries(ativos).map(([aid, carteira]) => [
            aid,
            { dashboard: carteira ? { carteira_atual: carteira } : null },
          ]),
        ),
      },
    ]),
  );
}

const real = (caixa, qtd, preco, naoRealizado = 0, em = '2026-08-21T12:00:00Z') =>
  ({ modo: 'real', saldo_moeda: caixa, saldo_ativo: qtd, preco_atual: preco, lucro_nao_realizado: naoRealizado, atualizada_em: em });
const simulado = (caixa, qtd, preco, naoRealizado = 0, em = '2026-08-21T13:00:00Z') =>
  ({ modo: 'simulacao', saldo_moeda: caixa, saldo_ativo: qtd, preco_atual: preco, lucro_nao_realizado: naoRealizado, atualizada_em: em });

test('carteira em SIMULAÇÃO não entra no patrimônio — nem o caixa, nem as posições', () => {
  const r = consolidarPatrimonio({
    plataformas: montar({
      BN: { moeda: 'BRL', ativos: { BNB: real(1000, 2, 50, 10), BTC: simulado(9999, 100, 500, 777) } },
    }),
  });
  assert.equal(r.caixaBRL, 1000, 'o caixa virtual de 9.999 fica de fora');
  assert.equal(r.patrimonioBRL, 1100, '1.000 de caixa + 2 × 50 de posição');
  assert.equal(r.naoRealizadoBRL, 10, 'o lucro não realizado da simulação fica de fora');
});

test('o snapshot virtual MAIS RECENTE não rouba o caixa do real', () => {
  // O defeito original: o caixa era o do snapshot mais novo, e o da simulação
  // costuma ser mais novo porque há mais ativos simulados analisando.
  const r = consolidarPatrimonio({
    plataformas: montar({
      BN: {
        moeda: 'BRL',
        ativos: {
          BNB: real(1172, 0, 0, 0, '2026-08-21T10:00:00Z'),
          BTC: simulado(1619, 0, 0, 0, '2026-08-21T23:00:00Z'), // mais recente
        },
      },
    }),
  });
  assert.equal(r.caixaBRL, 1172);
});

test('DUAS plataformas na mesma moeda somam os DOIS caixas', () => {
  // O outro defeito: o caixa era acumulado por MOEDA, então BN, MB e TORO
  // (todas em BRL) se sobrescreviam e só uma sobrevivia ao total.
  const r = consolidarPatrimonio({
    plataformas: montar({
      BN: { moeda: 'BRL', ativos: { BNB: real(1172, 0, 0) } },
      TORO: { moeda: 'BRL', ativos: { FIIR11: real(16, 245, 9.25, -34.98) } },
      MB: { moeda: 'BRL', ativos: { BTC: real(500, 0, 0) } },
    }),
  });
  assert.equal(r.caixaBRL, 1688, '1.172 + 16 + 500');
  assert.equal(Math.round(r.patrimonioBRL * 100) / 100, 1688 + 245 * 9.25);
});

test('o caixa da plataforma é o do snapshot mais recente, NUNCA a soma dos ativos', () => {
  // Todos os ativos de uma plataforma repetem o MESMO caixa. Somar contaria N×.
  const r = consolidarPatrimonio({
    plataformas: montar({
      TORO: {
        moeda: 'BRL',
        ativos: {
          FIIR11: real(16, 100, 10, 0, '2026-08-21T10:00:00Z'),
          ETFD11: real(16, 5, 100, 0, '2026-08-21T11:00:00Z'),
          ETFG11: real(16, 10, 150, 0, '2026-08-21T12:00:00Z'),
        },
      },
    }),
  });
  assert.equal(r.caixaBRL, 16, 'um caixa, não três');
  assert.equal(r.patrimonioBRL, 16 + 1000 + 500 + 1500);
});

test('moeda estrangeira é convertida pelo câmbio; sem cotação, fica FORA e é reportada', () => {
  const plataformas = montar({
    BN: { moeda: 'BRL', ativos: { BNB: real(100, 0, 0) } },
    TT: { moeda: 'USD', ativos: { AAPL: real(200, 1, 300, 50) } },
  });

  const comCambio = consolidarPatrimonio({ plataformas, cambio: { USD: { para_brl: 5 } } });
  assert.equal(comCambio.patrimonioBRL, 100 + (200 + 300) * 5);
  assert.equal(comCambio.naoRealizadoBRL, 50 * 5);
  assert.deepEqual(comCambio.semCambio, []);

  const semCambio = consolidarPatrimonio({ plataformas, cambio: null });
  assert.equal(semCambio.patrimonioBRL, 100, 'a USD não entra convertida por palpite');
  assert.deepEqual(semCambio.semCambio, ['USD'], 'e a tela avisa qual ficou de fora');
});

test('a plataforma excluída (Steam) não entra em nada', () => {
  const r = consolidarPatrimonio({
    plataformas: montar({
      BN: { moeda: 'BRL', ativos: { BNB: real(100, 0, 0) } },
      STEAM: { moeda: 'BRLS', ativos: { SKIN: real(50, 3, 200, 20) } },
    }),
    excluir: ['STEAM'],
  });
  assert.equal(r.patrimonioBRL, 100);
  assert.deepEqual(r.semCambio, [], 'excluída não vira "sem câmbio"');
  assert.equal(r.porPlataforma.has('STEAM'), false);
});

test('sem nenhuma carteira real, temDados é falso (a tela mostra "—", não zero)', () => {
  const r = consolidarPatrimonio({
    plataformas: montar({
      MB: { moeda: 'BRL', ativos: { BTC: simulado(1588, 5, 100, 30), ETH: simulado(1588, 0, 0) } },
    }),
  });
  assert.equal(r.temDados, false);
  assert.equal(r.patrimonioBRL, 0);
  assert.equal(r.porPlataforma.size, 0);
});

test('ativo sem snapshot nenhum não quebra a conta', () => {
  const plataformas = montar({ BN: { moeda: 'BRL', ativos: { BNB: real(100, 1, 10), NOVO: null } } });
  const r = consolidarPatrimonio({ plataformas });
  assert.equal(r.patrimonioBRL, 110);
  assert.equal(r.temDados, true);
});

test('o retrato de produção de 21/08: só o real sobra, e a conta bate', () => {
  // Os números que estavam no banco no dia em que o defeito foi encontrado.
  const r = consolidarPatrimonio({
    plataformas: montar({
      BN: {
        moeda: 'BRL',
        ativos: {
          BNB: real(1172, 0.00091488, 3475, 0.12),
          SOL: real(1172, 0.000179, 468.2, 0),
          BTC: simulado(1619.35, 0.00105365, 398274, -6.35),
        },
      },
      MB: { moeda: 'BRL', ativos: { BTC: simulado(1588.61, 0, 399198, 0) } },
      TORO: {
        moeda: 'BRL',
        ativos: {
          FIIR11: real(16, 245, 9.25, -34.98),
          ETFD11: real(16, 5, 118.75, 11.77),
          BDRT34: real(16, 22, 46.68, -124.17),
          ETFG11: real(16, 10, 149.57, 50.75),
        },
      },
    }),
  });
  // Caixa real: 1.172 (BN) + 16 (TORO). O da simulação não entra, e o da MB
  // some junto porque lá TUDO é simulação.
  assert.equal(r.caixaBRL, 1188);
  assert.equal(Math.round(r.patrimonioBRL), 6574);
  assert.equal(Math.round(r.naoRealizadoBRL * 100) / 100, -96.51);
});
