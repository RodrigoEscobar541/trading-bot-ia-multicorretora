// catalogo.test.js — cache TTL dos documentos de configuração (V5_2_Plan.MD
// §2.1): dentro do TTL o Firestore não é relido; TTL vencido ou
// invalidarCatalogo() forçam a releitura. Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOGO_TTL_MS,
  plataformasCache,
  apiCache,
  ativosCache,
  camadasPromptCache,
  invalidarCatalogo,
} from '../src/nucleo/catalogo.js';
import {
  inicializarPersistencia,
  salvarPlataforma,
  salvarApiPlataforma,
  salvarAtivo,
  salvarPromptAtivo,
  salvarRegrasGerais,
  salvarTemplatePlataforma,
  salvarContextoAtivo,
} from '../src/firebase/firebaseClient.js';

const T0 = Date.parse('2026-07-17T12:00:00Z');

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  invalidarCatalogo(); // o cache sobrevive à troca de backend entre testes
});

test('dentro do TTL o valor cacheado vale; vencido, relê a edição', async () => {
  await salvarPlataforma('MB', { nome: 'Antes' });
  const antes = await plataformasCache({ agoraMs: T0 });
  assert.equal(antes[0].nome, 'Antes');

  // Edição da dashboard: dentro do TTL o cache segura o valor antigo…
  await salvarPlataforma('MB', { nome: 'Depois' });
  const cacheado = await plataformasCache({ agoraMs: T0 + CATALOGO_TTL_MS - 1 });
  assert.equal(cacheado[0].nome, 'Antes');

  // …e com o TTL vencido a edição aparece.
  const relido = await plataformasCache({ agoraMs: T0 + CATALOGO_TTL_MS });
  assert.equal(relido[0].nome, 'Depois');
});

test('invalidarCatalogo força a releitura imediata (uso do bot e dos testes)', async () => {
  await salvarPlataforma('MB', { nome: 'Antes' });
  await plataformasCache({ agoraMs: T0 });
  await salvarPlataforma('MB', { nome: 'Depois' });
  invalidarCatalogo();
  const relido = await plataformasCache({ agoraMs: T0 });
  assert.equal(relido[0].nome, 'Depois');
});

test('api e ativos são cacheados POR plataforma (chaves independentes)', async () => {
  await salvarApiPlataforma('MB', { api_key_ia: 'chave-mb' });
  await salvarAtivo('MB', 'BTC', { manifest: { id: 'BTC' }, config: { ativo: true } });

  assert.equal((await apiCache('MB', { agoraMs: T0 })).api_key_ia, 'chave-mb');
  assert.equal((await ativosCache('MB', { agoraMs: T0 })).length, 1);

  // Outra plataforma não herda o cache da primeira.
  await salvarApiPlataforma('TT', { api_key_ia: 'chave-tt' });
  assert.equal((await apiCache('TT', { agoraMs: T0 })).api_key_ia, 'chave-tt');
  assert.deepEqual(await ativosCache('TT', { agoraMs: T0 }), []);
});

test('camadas do prompt vêm juntas e respeitam o TTL', async () => {
  await salvarAtivo('MB', 'BTC', { manifest: { id: 'BTC' } });
  await salvarPromptAtivo('MB', 'BTC', 'Prompt v1.');
  const camadas = await camadasPromptCache('MB', 'BTC', { agoraMs: T0 });
  assert.equal(camadas.promptAtivo.conteudo, 'Prompt v1.');
  assert.ok('regrasGerais' in camadas && 'template' in camadas && 'contexto' in camadas);

  await salvarPromptAtivo('MB', 'BTC', 'Prompt v2.');
  const cacheado = await camadasPromptCache('MB', 'BTC', { agoraMs: T0 + 1000 });
  assert.equal(cacheado.promptAtivo.conteudo, 'Prompt v1.');
  const relido = await camadasPromptCache('MB', 'BTC', { agoraMs: T0 + CATALOGO_TTL_MS });
  assert.equal(relido.promptAtivo.conteudo, 'Prompt v2.');
});

// --------------------------------------------------- escopo do cache (2026-07-26)
// Cada documento é cacheado no escopo em que ele VARIA: global, por plataforma
// ou por ativo. Guardar um doc global dentro da chave por ativo funciona e não
// dá erro nenhum — só faz N ativos lerem N vezes o mesmo documento, e leitura
// no caminho quente é orçada (CLAUDE.md §16). Leitura não é observável de fora,
// então os testes abaixo provam o escopo pelo EFEITO: alterar o doc por baixo
// do cache e ver quem ainda enxerga o valor antigo diz quem foi relido.

test('doc GLOBAL é lido uma vez e serve todos os ativos', async () => {
  await salvarRegrasGerais('regra v1');
  const btc = await camadasPromptCache('MB', 'BTC', { agoraMs: T0 });
  assert.equal(btc.regrasGerais.conteudo, 'regra v1');

  await salvarRegrasGerais('regra v2'); // edição por baixo do cache

  // Ativo que nunca passou por aqui: se as regras gerais morassem na chave por
  // ativo, esta chamada iria ao banco e veria a v2. Vendo a v1, está provado
  // que ela reaproveitou a leitura feita para o BTC.
  const eth = await camadasPromptCache('MB', 'ETH', { agoraMs: T0 });
  assert.equal(eth.regrasGerais.conteudo, 'regra v1');
  assert.equal(eth.regrasGerais, btc.regrasGerais, 'os dois ativos recebem o MESMO objeto');
});

test('template é compartilhado dentro da plataforma e nunca entre plataformas', async () => {
  await salvarTemplatePlataforma('MB', 'template do MB');
  await salvarTemplatePlataforma('BN', 'template da BN');
  assert.equal((await camadasPromptCache('MB', 'BTC', { agoraMs: T0 })).template.conteudo, 'template do MB');
  assert.equal((await camadasPromptCache('BN', 'BTC', { agoraMs: T0 })).template.conteudo, 'template da BN');

  await salvarTemplatePlataforma('MB', 'template do MB v2');
  // Outro ativo da MESMA plataforma reaproveita, sem reler…
  assert.equal((await camadasPromptCache('MB', 'ETH', { agoraMs: T0 })).template.conteudo, 'template do MB');
  // …e a BN nunca é contaminada pelo template do MB.
  assert.equal((await camadasPromptCache('BN', 'ETH', { agoraMs: T0 })).template.conteudo, 'template da BN');
});

test('prompt e contexto continuam POR ATIVO — um nunca vaza para o outro', async () => {
  await salvarPromptAtivo('MB', 'BTC', 'instruções do BTC');
  await salvarPromptAtivo('MB', 'ETH', 'instruções do ETH');
  await salvarContextoAtivo('MB', 'BTC', 'notícia do BTC');

  const btc = await camadasPromptCache('MB', 'BTC', { agoraMs: T0 });
  const eth = await camadasPromptCache('MB', 'ETH', { agoraMs: T0 });
  assert.equal(btc.promptAtivo.conteudo, 'instruções do BTC');
  assert.equal(eth.promptAtivo.conteudo, 'instruções do ETH');
  assert.equal(btc.contexto.texto, 'notícia do BTC');
  assert.equal(eth.contexto.texto, '');
});

test('invalidarCatalogo derruba também as camadas globais', async () => {
  // O supervisor semanal grava `global/supervisao` e chama isto. Se o clear não
  // alcançasse o escopo global, o analista seguiria lendo a camada da semana
  // passada por até 5 minutos depois de a nova ter sido escrita.
  await salvarRegrasGerais('antes');
  assert.equal((await camadasPromptCache('MB', 'BTC', { agoraMs: T0 })).regrasGerais.conteudo, 'antes');

  await salvarRegrasGerais('depois');
  invalidarCatalogo();
  assert.equal((await camadasPromptCache('MB', 'BTC', { agoraMs: T0 })).regrasGerais.conteudo, 'depois');
});

test('camadasPromptCache entrega TODAS as camadas que o montador espera', async () => {
  // Contrato com montadorPrompt.js: um campo que suma daqui vira uma camada
  // silenciosamente ausente do prompt — a IA passa a decidir com menos
  // instrução e nada no sistema acusa.
  const camadas = await camadasPromptCache('MB', 'BTC', { agoraMs: T0 });
  for (const campo of ['regrasGerais', 'regrasGeraisVenda', 'template', 'promptAtivo', 'supervisao', 'contexto']) {
    assert.ok(campo in camadas, `camada "${campo}" ausente`);
  }
});
