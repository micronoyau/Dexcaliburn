import { log } from "./logger.js";
import { createReadStream, createWriteStream } from "./frida-fs.js";
import { Buffer } from "buffer";

Java.perform(function () {
/* 
    var initialClasses = []

    Java.enumerateLoadedClasses({
        onMatch: function (className) {
            initialClasses.push(className);
        },
        onComplete: function () {
            console.log("Loaded initial classes");
        }
    });
 */
    
    console.log(Object.getOwnPropertyNames(Process));
    // Process.getCurrentDir()
/* 
    const PathClassLoader = Java.use('dalvik.system.PathClassLoader');
    const init = PathClassLoader.$init.overload('java.lang.String', 'java.lang.ClassLoader');

    init.implementation = function (dexPath, classLoader) {
        log("Loading " + dexPath);

        var readStream = createReadStream(dexPath)
        var dex_content = ""

        readStream
            .on('readable', function () {
                var chunk;
                while (null !== (chunk = readStream.read())) {
                    dex_content = dex_content.concat(chunk);
                }
            })
            .on('end', function () {
                const buf = Buffer.from(dex_content);
                const writeStream = createWriteStream('/data/user/0/???');
                writeStream.write(buf);
                writeStream.end();

                log("LOADED" + ... + "END");
            });

        return init.call(this, dexPath, classLoader);
    }
 */
})

