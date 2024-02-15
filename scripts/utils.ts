import { readFileSync2, writeFileSync } from "./frida-fs.js";
import { LOG_LEVEL } from "./index.js";

export function log(message: string): void {
    if(LOG_LEVEL>0) {
        console.log(message);
    }
}

export function log2(message: string): void {
    if(LOG_LEVEL>1) {
        console.log(message);
    }
}

export function debounce(func: any, timeout = 300){
  let timer: ReturnType<typeof setTimeout>;
  return function (this: any, ...args: any[]) {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}

export function makeid(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result;
}

export function readFile(input_file: string) {
    var buf = readFileSync2(input_file);
    return buf ? buf : [];
}

function legacySend(file_name: string, data: string, regexKey: string) {
    const ActivityThread = Java.use('android.app.ActivityThread');
    const currentApplication = ActivityThread.currentApplication();
    const context = currentApplication.getApplicationContext();
    const appPath = context.getDataDir().getAbsolutePath();
    const filePath = appPath + "/" + file_name;
    writeFileSync(filePath, data);
    log(regexKey + filePath + "END" + regexKey);
}
