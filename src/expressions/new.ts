import * as binaryen from "../binaryen";
import Compiler from "../compiler";
import * as reflection from "../reflection";
import * as typescript from "../typescript";

export function compileNew(compiler: Compiler, node: typescript.NewExpression, contextualType: reflection.Type): binaryen.Expression {
  const op = compiler.module;

  typescript.setReflectedType(node, compiler.uintptrType);

  if (node.expression.kind === typescript.SyntaxKind.Identifier) {
    const identifierNode = <typescript.Identifier>node.expression;

    // TODO: These are hard-coded but should go through compileNewClass -> compileNewArray eventually

    // new Array<T>(size)
    if (identifierNode.text === "Array" && node.arguments && node.arguments.length === 1 && node.typeArguments && node.typeArguments.length === 1)
      return compileNewArray(compiler, node, compiler.resolveType(node.typeArguments[0]), <typescript.Expression>node.arguments[0]);

    // new String(size)
    if (identifierNode.text === "String" && node.arguments && node.arguments.length === 1 && !node.typeArguments)
      return compileNewArray(compiler, node, reflection.ushortType, <typescript.Expression>node.arguments[0]);

    const reference = compiler.resolveReference(identifierNode);

    if (reference instanceof reflection.Class)
      return compileNewClass(compiler, node, <reflection.Class>reference);

    if (reference instanceof reflection.ClassTemplate) {
      const template = <reflection.ClassTemplate>reference;
      const instance = template.resolve(compiler, node.typeArguments || []);
      instance.initialize(compiler);
      return compileNewClass(compiler, node, instance);
    }
  }

  compiler.error(node, "Unsupported operation");
  return op.unreachable();
}

export function compileNewClass(compiler: Compiler, node: typescript.NewExpression, clazz: reflection.Class): binaryen.Expression {
  const op = compiler.module;
  const binaryenPtrType = binaryen.typeOf(compiler.uintptrType, compiler.uintptrSize);

  // ptr = malloc(classSize)

  let ptr = op.block("", [
    op.call("malloc", [ // use wrapped malloc here so mspace_malloc can be inlined
      binaryen.valueOf(compiler.uintptrType, op, clazz.size)
    ], binaryenPtrType)
  ], binaryenPtrType);

  if (clazz.ctor) {

    // return ClassConstructor(ptr, arguments...)

    const parameterCount = clazz.ctor.parameters.length;
    const argumentCount = node.arguments && node.arguments.length || 0;
    const args = new Array(parameterCount + 1);
    args[0] = ptr; // first constructor parameter is 'this'
    let i = 0;
    let tooFewDiagnosed = false;
    for (; i < parameterCount; ++i) {
      const parameter = clazz.ctor.parameters[i];
      if (argumentCount > i) {
        const argumentNode = (<typescript.NodeArray<typescript.Expression>>node.arguments)[i];
        args[i + 1] = compiler.maybeConvertValue(argumentNode, compiler.compileExpression(argumentNode, parameter.type), typescript.getReflectedType(argumentNode), parameter.type, false);
      } else { // TODO: use default value if defined
        if (!tooFewDiagnosed) {
          tooFewDiagnosed = true;
          compiler.error(node, "Too few arguments", "Expected " + parameterCount + " but saw " + argumentCount);
        }
        args[i + 1] = compiler.module.unreachable();
      }
    }
    if (argumentCount > i)
      compiler.error(node, "Too many arguments", "Expected " + parameterCount + " but saw " + argumentCount);
    ptr = op.call(clazz.ctor.name, args, binaryen.typeOf(clazz.ctor.returnType, compiler.uintptrSize));
  }

  return ptr;
}

export function compileNewArray(compiler: Compiler, node: typescript.NewExpression, elementType: reflection.Type, sizeArgument: typescript.Expression) {
  const op = compiler.module;

  const sizeExpression = compiler.maybeConvertValue(sizeArgument, compiler.compileExpression(sizeArgument, compiler.uintptrType), typescript.getReflectedType(sizeArgument), compiler.uintptrType, false);
  const cat = binaryen.categoryOf(compiler.uintptrType, compiler.module, compiler.uintptrSize);
  const newsize = compiler.currentFunction.localsByName[".newsize"] || compiler.currentFunction.addLocal(".newsize", reflection.uintType);
  const newptr = compiler.currentFunction.localsByName[".newptr"] || compiler.currentFunction.addLocal(".newptr", compiler.uintptrType);
  const binaryenPtrType = binaryen.typeOf(compiler.uintptrType, compiler.uintptrSize);

  // *(.newptr = malloc(4 + size * (.newsize = EXPR))) = .newsize
  // return .newptr

  return op.block("", [
    cat.store(
      0,
      compiler.uintptrType.size,
      op.teeLocal(newptr.index,
        op.call("malloc", [ // use wrapped malloc here so mspace_malloc can be inlined
          cat.add(
            binaryen.valueOf(compiler.uintptrType, op, 4),
            cat.mul(
              binaryen.valueOf(compiler.uintptrType, op, elementType.size),
              op.teeLocal(newsize.index, sizeExpression)
            )
          )
        ], binaryenPtrType)
      ),
      op.getLocal(newsize.index, binaryen.typeOf(reflection.uintType, compiler.uintptrSize))
    ),
    op.getLocal(newptr.index, binaryenPtrType)
  ], binaryenPtrType);
}

// TODO: String (an ushort array basically)