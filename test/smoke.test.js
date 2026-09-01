'use strict';

// 前端静态冒烟检查:app.js 中所有被调用的函数必须已定义(防止清理代码时误删函数导致运行时白屏)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BUILTINS = new Set([
  'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'WebSocket', 'URLSearchParams', 'structuredClone', 'queueMicrotask',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'Set', 'Map', 'Promise', 'RegExp', 'Error', 'TypeError', 'console',
  'localStorage', 'navigator', 'location', 'document', 'PROTOCOL', 'isNaN',
  'parseInt', 'parseFloat', 'decodeURIComponent', 'encodeURIComponent', 'alert'
]);
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new',
  'delete', 'void', 'do', 'try', 'else', 'in', 'of', 'await', 'async'
]);

test('app.js 函数引用完整性(所有被调用的本地函数都有定义)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const declared = new Set();
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);

  // 函数参数名(含箭头函数与解构)也算已声明,避免回调误报
  const params = new Set();
  const collect = (list) => {
    for (const piece of list.split(',')) {
      const tok = piece.replace(/[[\]{}]/g, '').trim().split(/[:=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(tok)) params.add(tok);
    }
  };
  for (const m of src.matchAll(/function\s+[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) collect(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) collect(m[1]);

  const called = new Set();
  // 排除属性调用(xxx.foo() 只匹配 foo 前不是 . 的)
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);

  const missing = [...called].filter(
    (n) => !declared.has(n) && !params.has(n) && !BUILTINS.has(n) && !KEYWORDS.has(n)
  );
  assert.deepStrictEqual(
    missing.sort(),
    [],
    `app.js 引用了未定义的函数(会被误删导致运行时崩溃): ${missing.join(', ')}`
  );
});
