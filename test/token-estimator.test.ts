import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  clearRemoteModelContextWindows,
  formatTokens,
  getModelContextWindow,
  setRemoteModelContextWindow,
} = await import('../src/utils/token-estimator.js')

// 远端窗口是进程级缓存：每个用例前后都清，避免互相串味

test('没注入远端值时统一回退 1M 兜底（不再查内置表）', () => {
  clearRemoteModelContextWindows()
  assert.deepEqual(getModelContextWindow('deepseek-chat'), {
    contextWindow: 1_000_000,
    outputReserve: 100_000,
    effectiveInput: 900_000,
  })
})

test('未知模型同样落 1M 兜底', () => {
  clearRemoteModelContextWindows()
  assert.equal(getModelContextWindow('some-unknown-model').effectiveInput, 900_000)
})

test('formatTokens：/1000 四舍五入，<1M 用 K、≥1M 用 M（一位小数）', () => {
  assert.equal(formatTokens(42), '42')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1K')
  assert.equal(formatTokens(2738), '3K')
  assert.equal(formatTokens(655_360), '655K')
  assert.equal(formatTokens(999_499), '999K')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(1_048_576), '1M')
  assert.equal(formatTokens(2_350_000), '2.4M')
})

test('注入远端值后压过内置表，且匹配大小写/空格不敏感', () => {
  clearRemoteModelContextWindows()
  setRemoteModelContextWindow('DeepSeek-Flash', {
    contextWindow: 1_048_576,
    outputReserve: 393_216,
    effectiveInput: 0, // setter 会重算
  })
  const window = getModelContextWindow(' deepseek-flash ')
  assert.deepEqual(window, {
    contextWindow: 1_048_576,
    outputReserve: 393_216,
    effectiveInput: 1_048_576 - 393_216,
  })
  clearRemoteModelContextWindows()
})

test('reserve ≥ 窗口时被夹住，effectiveInput 不为 0', () => {
  clearRemoteModelContextWindows()
  setRemoteModelContextWindow('m', { contextWindow: 100, outputReserve: 500, effectiveInput: 0 })
  assert.equal(getModelContextWindow('m').effectiveInput, 1)
  clearRemoteModelContextWindows()
})
