'use strict';

module.exports = [
  { ignores: ['reference/**'] },
  {
    files: ['panel/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        CSInterface: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      'no-var': 'off',
      strict: 'off'
    }
  },
  {
    files: ['panel/jsx/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 3,
      sourceType: 'script',
      globals: {
        app: 'readonly',
        $: 'readonly',
        CSXSEvent: 'readonly',
        File: 'readonly',
        Time: 'readonly'
      }
    },
    rules: {
      'func-style': ['error', 'expression']
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly'
      }
    }
  }
];
