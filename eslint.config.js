// ESLint flat config —— 重点抓 no-undef(未定义变量,如"改名漏改"),辅以未用变量告警。
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'tmp.mjs', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // Node 18+ 全局(部分 globals 版本未收录,显式声明避免 no-undef 误报)
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        AbortSignal: 'readonly',
        Intl: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error', // ★ 未定义变量直接报错(会拦下 CI)
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
