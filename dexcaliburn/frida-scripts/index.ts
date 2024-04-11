/**
 * Frida script. Goals :
 * + Intercept dynamically loaded bytecode and dump it
 * + Intercept reflexive method calls
 * Should be run by server, or manually for debug purposes only.
 */

import { getJSBufferFromJavaBuffer, getJavaBufferFromPath, log, log2, sha256_fromFilePath, sha256_fromJavaBuffer } from "./utils.js";

export const LOG_LEVEL = 1
enum LocationSource {
  DEBUG = 'debug',
  BINARY = 'binary'
};

// Data gathered during runtime
let runData: {
  dexFiles: string[],
  xrefs: {
    method: {
      className: string,
      methodName: string,
      prototype: string
    }
    location: {
      callingMethod: string,
      position: number,
      source: LocationSource
    },
    count: number
  }[]
} = { dexFiles: [], xrefs: [] };

// Key : class name, value : methods to be dynamically hooked
let hookedMethods: { [key: string]: string[] } = {}

Java.perform(function() {
  fetchHookConfig();
  setupExitHandler();
  overrideloadClassForDynHooking();
  overrideClassLoaderInit();
  captureInvokeCalls();
})

/**
 * Receives a list of methods to be dynamically hooked
 */
function fetchHookConfig() {
  send({ id: "setup" });
  recv('hooks', (val) => {
    if (val.payload == '') return;
    val.payload.trim().split('\n').forEach((line: string) => {
      let className = line.split('.').slice(0, -1).join('.');
      let methodName = line.split('.').slice(-1)[0];
      if (className in hookedMethods) {
        hookedMethods[className].push(methodName);
      } else {
        hookedMethods[className] = [methodName];
      }
    });
  }).wait();
}

/**
 * Sets up the handler to send all data upon quitting
 */
function setupExitHandler() {
  recv('rundata', (_) => {
    send({ id: "rundata", runData: runData });
  });
}

function overrideloadClassForDynHooking() {
  for (let classLoaderName of ['InMemoryDexClassLoader', 'DexClassLoader', 'PathClassLoader', 'DelegateLastClassLoader']) {
    const classLoader = tryJavaUse('dalvik.system.' + classLoaderName);
    if (!classLoader) continue;
    tryOverride(() => {
      const loadClass = classLoader.loadClass.overload('java.lang.String');
      loadClass.implementation = function(className: string) {
        let ret = loadClass.call(this, className);
        if (className in hookedMethods) {
          hookedMethods[className].forEach((methodName: string) => {
            hookDynamicMethod(className, methodName);
          });
        }
        return ret;
      }
    }, `${classLoaderName}.loadClass(String className)`);
  }
}

/**
 * Each time a reflexive call is attempted, stores the following :
 * + Full method name
 * + Java exception stack trace
 */
function captureInvokeCalls() {
  const invoke = Java.use('java.lang.reflect.Method').invoke.overload("java.lang.Object", "[Ljava.lang.Object;");

  invoke.implementation = function(obj1: Object, obj2: Object[]) {
    log2("Invoked : " + this.getName());

    const Method = Java.use('java.lang.reflect.Method');
    const Class = Java.use('java.lang.Class');
    const Thread = Java.use('java.lang.Thread');
    const StackTraceElement = Java.use('java.lang.StackTraceElement');

    // Reflexively-invoked method info
    const methodClass = Method.getDeclaringClass.call(this);
    const className = Class.getCanonicalName.call(methodClass);
    const methodName = Method.getName.call(this);
    const returnType = Method.getReturnType.call(this);
    const returnTypeName = Class.getCanonicalName.call(returnType);
    const parameterTypes = Method.getParameterTypes.call(this);

    let method = {
      className,
      methodName,
      prototype: returnTypeName + '(' +
        parameterTypes.map((elem: any) => Class.getCanonicalName.call(elem)).join(', ')
        + ')'
    }

    // Calling method
    const thread = Thread.currentThread.call(Thread);
    const trace = Thread.getStackTrace.call(thread);
    // 3 because interesting method -> invoke -> getStackTrace -> getThreadStackTrace
    const callingMethod = StackTraceElement.getMethodName.call(trace[3]);
    const position = StackTraceElement.getLineNumber.call(trace[3]);
    const filename = StackTraceElement.getFileName.call(trace[3]);
    const source = filename.match(/.*\.java/) ? LocationSource.DEBUG : LocationSource.BINARY;

    // JS does not allow tuple-indexed dictionaries, this is an non-optimal way around
    let xref_index = runData.xrefs.findIndex(xref =>
      (xref.method.className === method.className)
      && (xref.method.methodName === method.methodName)
      && (xref.method.prototype === method.prototype)
      && (xref.location.callingMethod === callingMethod)
      && (xref.location.position === position)
      && (xref.location.source === source));
    if (xref_index == -1) {
      runData.xrefs.push({
        method,
        location: {
          callingMethod,
          position,
          source
        },
        count: 1
      });
    } else {
      runData.xrefs[xref_index].count += 1;
    }

    return invoke.call(this, obj1, obj2);
  }
}

/**
 * Basic hook for dynamically loaded methods : dump arguments
 */
function hookDynamicMethod(className: string, methodName: string) {
  Java.enumerateClassLoadersSync().forEach((loader) => {
    try {
      let clazz = Java.ClassFactory.get(loader).use(className);
      let method = clazz[methodName];
      method.overloads.forEach((overload: any) => {
        overload.implementation = function(...args: any) {
          console.log("Called : " + methodName + "(" + overload.argumentTypes.map((elem: any) => elem.className).join(', ') + ")");
          console.log("Args : ", args);
          return overload.call(this, ...args);
        };
      });
    } catch (e) {
    }
  });
}

/**
 * Depending on the current API, some loaders might or might not be available.
 */
function tryOverride(loader: any, loader_prototype: string) {
  try {
    loader();
  } catch (e) {
    log2("Unable to override " + loader_prototype);
  }
}

/**
 * Depending on the current API, some loaders might or might not be available.
 */
function tryJavaUse(className: string) {
  try {
    return Java.use(className);
  } catch (e) {
    log(`Could not find ${className}`);
    return null;
  }
}

/**
 * Return a default implementation for a memory dependent classLoader init method
 */
function memoryClassLoaderHookSetup(first_argument_is_array: boolean) {
  return function(init_method: Java.Method<{}>) {
    return function(this: any, ...args: any[]) {
      log("Loading new dex from memory buffer");
      let bufferArray = args[0];
      if (!first_argument_is_array) {
        bufferArray = [bufferArray]
      }

      for (let buffer of bufferArray) {
        const jsBuffer = getJSBufferFromJavaBuffer(buffer.array());
        let filename = 'memory-' + sha256_fromJavaBuffer(buffer);
        log(`Sending dex as '${filename}'`)
        send({ id: "dex", filename: filename }, jsBuffer)
        runData.dexFiles.push(filename);
      }
      return init_method.call(this, ...args);
    }
  }
}

/**
 * Return a default implementation for a file dependent classLoader init method
 */
function fileClassLoaderHook(init_method: Java.Method<{}>) {
  return function(this: any, ...args: any[]) {
    let dexPath = args[0];
    log("Loading new dex from file: " + dexPath);
    let filename = dexPath.split('/').slice(-1)[0] + '-' + sha256_fromFilePath(dexPath);
    log(`Sending dex as '${filename}'`)
    send({ id: "dex", filename: filename }, getJSBufferFromJavaBuffer(getJavaBufferFromPath(dexPath)))
    runData.dexFiles.push(filename);
    return init_method.call(this, ...args);
  }
}

/**
 * Each time a loader is initialized, sends a message with the loaded bytecode
 */
function overrideClassLoaderInit() {
  const BaseDexClassLoader = tryJavaUse('dalvik.system.BaseDexClassLoader');
  const InMemoryDexClassLoader = tryJavaUse('dalvik.system.InMemoryDexClassLoader');
  const DexClassLoader = tryJavaUse('dalvik.system.DexClassLoader');
  const PathClassLoader = tryJavaUse('dalvik.system.PathClassLoader');
  const DelegateLastClassLoader = tryJavaUse('dalvik.system.DelegateLastClassLoader');

  const registry = [
    {
      classLoader: BaseDexClassLoader, argsList: ['java.lang.String', 'java.io.File', 'java.lang.String', 'java.lang.ClassLoader'],
      hook: fileClassLoaderHook, debugString: "BaseDexClassLoader(String dexPath, File optimizedDirectory, String librarySearchPath, ClassLoader parent)"
    },
    {
      classLoader: InMemoryDexClassLoader, argsList: ['[java.nio.ByteBuffer;', 'java.lang.String', 'java.lang.ClassLoader'],
      hook: memoryClassLoaderHookSetup(true), debugString: "InMemoryDexClassLoader(ByteBuffer[] dexBuffers, String librarySearchPath, ClassLoader parent)"
    },
    {
      classLoader: InMemoryDexClassLoader, argsList: ['[java.nio.ByteBuffer', 'java.lang.ClassLoader'],
      hook: memoryClassLoaderHookSetup(true), debugString: "InMemoryDexClassLoader(ByteBuffer[] dexBuffers, ClassLoader parent)"
    },
    {
      classLoader: InMemoryDexClassLoader, argsList: ['java.nio.ByteBuffer', 'java.lang.ClassLoader'],
      hook: memoryClassLoaderHookSetup(false), debugString: "InMemoryDexClassLoader(ByteBuffer dexBuffer, ClassLoader parent)"
    },
    {
      classLoader: DexClassLoader, argsList: ['java.lang.String', 'java.lang.String', 'java.lang.String', 'java.lang.ClassLoader'],
      hook: fileClassLoaderHook, debugString: "DexClassLoader(String dexPath, String optimizedDirectory, String librarySearchPath, ClassLoader parent)"
    },
    {
      classLoader: PathClassLoader, argsList: ['java.lang.String', 'java.lang.ClassLoader'],
      hook: fileClassLoaderHook, debugString: "PathClassLoader(String dexPath, ClassLoader parent)"
    },
    {
      classLoader: DelegateLastClassLoader, argsList: ['java.lang.String', 'java.lang.ClassLoader'],
      hook: fileClassLoaderHook, debugString: "DelegateLastClassLoader(String dexPath, ClassLoader parent)"
    },
    {
      classLoader: DelegateLastClassLoader, argsList: ['java.lang.String', 'java.lang.String', 'java.lang.ClassLoader'],
      hook: fileClassLoaderHook, debugString: "DelegateLastClassLoader(String dexPath, String librarySearchPath, ClassLoader parent)"
    },
    {
      classLoader: DelegateLastClassLoader, argsList: ['java.lang.String', 'java.lang.String', 'java.lang.ClassLoader', 'boolean'],
      hook: fileClassLoaderHook, debugString: "DelegateLastClassLoader(String dexPath, String librarySearchPath, ClassLoader parent, boolean delegateResourceLoading)"
    },
  ];

  for (let { classLoader, hook, argsList, debugString } of registry) {
    tryOverride(() => {
      if (!classLoader) return;
      const init = classLoader.$init.overload(...argsList);
      init.implementation = hook(init);
    }, debugString);
  }
}
