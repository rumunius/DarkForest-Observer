import ts from 'typescript';

/** Require callers to name generic contracts that cannot be inferred from inputs. */
export const explicitReturnGenerics = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      missing:
        'Specify type arguments explicitly when the generic contract has no input type to infer from.',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error('explicit-return-generics requires type-aware parsing.');
    }
    const checker = services.program.getTypeChecker();
    return {
      CallExpression(node) {
        if (node.typeArguments?.params.length) {
          return;
        }
        const call = services.esTreeNodeToTSNodeMap.get(node);
        const declaration = checker.getResolvedSignature(call)?.declaration;
        if (!declaration?.typeParameters?.length) {
          return;
        }
        const typeParameters = new Set(
          declaration.typeParameters.map(parameter =>
            checker.getSymbolAtLocation(parameter.name),
          ),
        );
        const inferable = new Set();
        const visit = child => {
          if (ts.isIdentifier(child)) {
            const symbol = checker.getSymbolAtLocation(child);
            if (symbol && typeParameters.has(symbol)) {
              inferable.add(symbol);
            }
          }
          ts.forEachChild(child, visit);
        };
        for (const parameter of declaration.parameters) {
          if (parameter.type) {
            visit(parameter.type);
          }
        }
        if (inferable.size < typeParameters.size) {
          // Choosing a type changes the contract, so this rule must not guess a fix.
          context.report({node, messageId: 'missing'});
        }
      },
    };
  },
};

/** Require public contracts to explain intent, rather than relying on names alone. */
export const documentedExports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require meaningful JSDoc on top-level exported declarations',
    },
    schema: [],
    messages: {
      missing:
        'Document this exported contract: purpose, constraints or side effects.',
    },
  },
  create(context) {
    return {
      ExportNamedDeclaration(node) {
        if (!node.declaration) {
          return;
        }
        const comments = context.sourceCode.getCommentsBefore(node);
        const comment = comments.at(-1);
        if (
          !comment ||
          comment.type !== 'Block' ||
          !comment.value.startsWith('*') ||
          comment.value.replace(/[\s*]/g, '').length < 12
        ) {
          context.report({node: node.declaration, messageId: 'missing'});
        }
      },
    };
  },
};

/** Keep adjacent class methods and constructors visually separate, including their JSDoc. */
export const spacedClassMethods = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: [],
    messages: {
      missing: 'Separate class methods and constructors with a blank line.',
    },
  },
  create(context) {
    return {
      ClassBody(node) {
        for (let index = 1; index < node.body.length; index++) {
          const previous = node.body[index - 1];
          const current = node.body[index];
          if (
            previous.type !== 'MethodDefinition' &&
            current.type !== 'MethodDefinition'
          ) {
            continue;
          }
          // Overload signatures belong to one method and remain together.
          if (previous.type === 'MethodDefinition' && !previous.value.body) {
            continue;
          }
          const leading = context.sourceCode
            .getCommentsBefore(current)
            .find(comment => comment.range[0] >= previous.range[1]);
          const end = leading?.range[0] ?? current.range[0];
          const gap = context.sourceCode.text.slice(previous.range[1], end);
          if (!/\n\s*\n/.test(gap)) {
            context.report({
              node: current,
              messageId: 'missing',
              fix: fixer => fixer.insertTextAfter(previous, '\n'),
            });
          }
        }
      },
    };
  },
};

/** Prefer declarations for module-level named functions, retaining typed arrow interfaces. */
export const namedFunctions = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      declaration:
        'Use a function declaration for a module-level named function.',
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (
          node.init?.type !== 'ArrowFunctionExpression' ||
          node.id.type !== 'Identifier' ||
          node.id.typeAnnotation
        ) {
          return;
        }
        const parent = node.parent.parent;
        if (
          parent.type === 'Program' ||
          parent.type === 'ExportNamedDeclaration'
        ) {
          context.report({node, messageId: 'declaration'});
        }
      },
    };
  },
};

/** Keep imports before implementation, separated from its leading documentation. */
export const moduleLayout = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: [],
    messages: {
      late: 'Keep module imports before the file implementation.',
      separator: 'Separate imports and implementation with one blank line.',
    },
  },
  create(context) {
    return {
      Program(node) {
        let firstImplementation;
        let lastImport;
        let lateImport = false;
        for (const statement of node.body) {
          if (statement.type === 'ImportDeclaration') {
            lastImport = statement;
            if (firstImplementation) {
              lateImport = true;
              context.report({node: statement, messageId: 'late'});
            }
          } else {
            firstImplementation ??= statement;
          }
        }
        if (!lastImport || !firstImplementation || lateImport) {
          return;
        }
        const comments = context.sourceCode
          .getCommentsBefore(firstImplementation)
          .filter(comment => comment.range[0] >= lastImport.range[1]);
        const trailing = comments.filter(
          comment => comment.loc.start.line === lastImport.loc.end.line,
        );
        const start = trailing.at(-1)?.range[1] ?? lastImport.range[1];
        const leading = comments.find(
          comment => comment.loc.start.line > lastImport.loc.end.line,
        );
        const end = leading?.range[0] ?? firstImplementation.range[0];
        const gap = context.sourceCode.text.slice(start, end);
        if (/^\s*$/.test(gap) && gap !== '\n\n') {
          context.report({
            node: firstImplementation,
            messageId: 'separator',
            fix: fixer => fixer.replaceTextRange([start, end], '\n\n'),
          });
        }
      },
    };
  },
};
