#!/bin/zsh
set -eu
cd -- "${0:A:h}"
print 'Семья: http://127.0.0.1:4317'
print 'Оставьте это окно открытым. Для остановки нажмите Ctrl+C.'
exec npm run local
