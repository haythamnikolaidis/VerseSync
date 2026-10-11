'use strict';

module.exports = [
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
