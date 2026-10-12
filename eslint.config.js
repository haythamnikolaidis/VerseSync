'use strict';

// Host script rules. Premiere's ExtendScript engine is ES3: espree is told to parse ES3, so
// trailing commas, getters, reserved-word property names and the like fail to parse, and the
// selectors below reject the ES5 library calls that parse fine but do not exist at runtime.
// docs/08-premiere-host-api.md section 1 is the source of these rules.
var ES5_ARRAY_METHODS = [
  'forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'lastIndexOf'
];

var hostRules = {
  // `function fn(){}` is not hoisted into the persistent global scope by $.evalFile().
  'no-restricted-syntax': [
    'error',
    {
      selector: 'FunctionDeclaration',
      message: 'Use `var fn = function () {}`: $.evalFile() does not hoist function declarations.'
    },
    {
      selector: 'CallExpression[callee.property.name=/^(' + ES5_ARRAY_METHODS.join('|') + ')$/]',
      message: 'ES5 array methods do not exist in ExtendScript (ES3). Use a for loop.'
    },
    {
      selector: 'CallExpression[callee.property.name=/^(trim|bind)$/]',
      message: '.trim() and .bind() do not exist in ExtendScript (ES3).'
    },
    {
      selector: 'CallExpression[callee.object.name="Object"][callee.property.name=/^(keys|create|defineProperty|defineProperties|getPrototypeOf|freeze|seal|getOwnPropertyNames)$/]',
      message: 'ES5 Object statics do not exist in ExtendScript (ES3).'
    },
    {
      selector: 'CallExpression[callee.object.name="Array"][callee.property.name="isArray"]',
      message: 'Array.isArray does not exist in ExtendScript (ES3). Use instanceof Array.'
    },
    {
      selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
      message: 'Date.now does not exist in ExtendScript (ES3). Use new Date().getTime().'
    },
    {
      selector: 'MemberExpression[computed=true][object.type="Literal"]',
      message: 'Indexing a string literal is not ES3.'
    },
    {
      selector: 'MemberExpression[object.name="JSON"][property.name!=/^(parse|stringify)$/]',
      message: 'Only JSON.parse and JSON.stringify (the file\'s own polyfill) are available.'
    },
    {
      selector: 'TemplateLiteral, ArrowFunctionExpression, ClassDeclaration',
      message: 'Not ES3.'
    }
  ],
  // A trailing comma in an array literal changes its length in ES3 engines.
  'comma-dangle': ['error', 'never'],
  'no-undef': 'error',
  'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
  'vs-host/ascii-only': 'error',
  // JSON polyfill regex ranges use control characters on purpose.
  'no-control-regex': 'off'
};

// Rejects any non-ASCII character anywhere in the file, comments included: the host is
// loaded through $.evalFile(), which mangles non-ASCII source. Non-ASCII text in a string is
// written as a \uXXXX escape instead.
var asciiOnly = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { nonAscii: 'Non-ASCII character U+{{code}} at line {{line}}, column {{column}}. Host source must be ASCII-only; use a \\uXXXX escape.' }
  },
  create: function (context) {
    return {
      Program: function () {
        var lines = context.sourceCode.getText().split(/\r\n|\r|\n/);
        lines.forEach(function (text, i) {
          var m = /[^\x00-\x7f]/.exec(text);
          if (m) {
            context.report({
              loc: { line: i + 1, column: m.index },
              messageId: 'nonAscii',
              data: {
                code: ('0000' + text.charCodeAt(m.index).toString(16).toUpperCase()).slice(-4),
                line: i + 1,
                column: m.index + 1
              }
            });
          }
        });
      }
    };
  }
};

module.exports = [
  {
    files: ['panel/jsx/**/*.jsx'],
    plugins: { 'vs-host': { rules: { 'ascii-only': asciiOnly } } },
    languageOptions: {
      ecmaVersion: 3,
      sourceType: 'script',
      globals: {
        app: 'readonly',
        $: 'readonly',
        Time: 'readonly',
        CSXSEvent: 'readonly',
        File: 'readonly',
        Folder: 'readonly',
        eval: 'readonly',
        // The file defines its own JSON polyfill when the engine has none.
        JSON: 'writable',
        VS: 'writable'
      }
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: hostRules
  },
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
        module: 'readonly',
        __dirname: 'readonly'
      }
    }
  }
];
