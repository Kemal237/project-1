const Module = require('module')
// Проверяем, зарегистрирован ли 'electron' как встроенный модуль
const isBuiltin = Module.builtinModules.includes('electron')
process.stdout.write('electron in builtins: ' + isBuiltin + '\n')
process.stdout.write('builtins with e: ' + Module.builtinModules.filter(m => m.startsWith('e')).join(',') + '\n')
process.stdout.write('electron in cache: ' + ('electron' in Module._cache) + '\n')
process.stdout.write('process.type: ' + process.type + '\n')
process.exit(0)
