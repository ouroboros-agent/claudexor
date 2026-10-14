# Answer

**CODE: PASS с указанными ограничениями. COUPLING: PASS с указанными ограничениями.** Блокирующих дефектов двухфайловой коррекции не установлено. Это не заключение о готовности релиза.

Проверен HEAD `9b937ec8637031b66d9c71ecd6f960750931533f`, дерево `85d7052979728a91b3ad64538898088171796575`. Обе SHA256 файлов совпали с заданными. Полный `git diff HEAD` побайтно равен [прочитанному целиком патчу](retained-evidence/cx-sip-materialized.patch), SHA256 `0110cbd71df2dae8af284fb74d3a51b59c4e40e7602f9188f5f4dbc990e3612c`: только два тестовых файла, +100/−10. Повторная проверка в конце подтвердила неизменность объекта.

Основания CODE:

- **N1 имеет отдельный источник ожидаемого результата.** [environmentShows](workspace/packages/core/src/process-scope-census.test.ts:1074) использует собственный вызов `/bin/ps` с ограничением 5 секунд либо непосредственное чтение `/proc`. Он не вызывает production runner/parser. Ошибка чтения выбрасывается, а не превращается в «окружение скрыто». Проверяется точная запись маркера; Linux по-прежнему обязан показать её.
- **Обе ветви проверяют результат работы.** [N1](workspace/packages/core/src/process-scope-census.test.ts:1262) проверяет положительный PID, существование процесса, измеренный birth token, собственный и чужой маркеры. При видимом окружении требуется реальное завершение именно этого PID с тем же token; при скрытом — пустой `ended` и сохранение той же identity. В обеих Darwin-ветвях обязательны `restricted=true` и `completeness=not_provable`. Утверждения выполняются до `finally`, поэтому последующая уборка не может замаскировать ошибку reaper.
- **N2 обеспечивает обе стороны независимо от ОС запуска.** [Таблица fakePs](workspace/packages/core/src/process-scope-readers.test.ts:235) проверяет census для двух маркеров и четыре результата `confirm`: показанное окружение, скрытое окружение, чужой маркер и положительное подтверждение второго маркера. Существующие [проверки ошибок ps](workspace/packages/core/src/process-scope-readers.test.ts:144) отдельно сохраняют различие между исчезнувшим PID, отсутствующей записью и настоящей ошибкой (`null`/failed).

Для COUPLING прочитаны реальные readers/census, используемые Linux/Darwin identity-пути, генерация маркеров и соответствующие test helpers. Проверены существующие утверждения о чужом scope, смене birth/PGID, известных нечитаемых участниках, recorded-group discovery и [нечитаемых Linux discovery candidates](workspace/packages/core/src/process-scope-census.test.ts:905). Коррекция сохраняет различие между `settled` и доказанной полнотой очистки.

Также проверены [запись фактов](workspace/packages/orchestrator/src/runScope.ts:102), схемы, [проекция API](workspace/packages/control-api/src/run-detail-scope.ts:20) и существующие HTTP-assertions сохранения ответа, survivors и explicit null. Эти пути не изменены. Их проверки дают существующее покрытие потребителей; нового сквозного исполнения Darwin → HTTP эта коррекция не доказывает.

Материалы QA проверены чтением [полного result.json](retained-evidence/cx-sip-focused-resumed/result.json), сырых XML и логов. Оба итоговых прогона содержат **63 выполненных теста, 0 failures/errors, 0 skips**. Falsifiers падают на ожидаемых assertions: always-true — строка 258, always-false — 255, неверная Darwin completeness — 1285. Записаны успешные workspace build, typecheck-tests и format. Сам я ничего не запускал.

Остаточные ограничения:

- [Существующий finally](workspace/packages/core/src/process-scope-census.test.ts:1303) отправляет SIGKILL по числовому PID, подавляет ошибки и не подтверждает завершение. Новая readable-ветвь приходит сюда уже после reap. Поэтому безопасность при переиспользовании PID и гарантированная окончательная уборка этим тестом не доказаны. Это неблокирующее замечание к тестовой уборке; случая переиспользования я не воспроизводил.
- Независимость oracle ограничена runner/parser: kernel/ps остаются общими, identity-reader также используется production-кодом. Существующие Darwin/SIP и argv/environment ограничения сохраняются.
- [Release-лог](retained-evidence/release-candidate-38535646188-macos.log:3446) подтверждает старое `expected false / received true` и 8080 PASS / 1 FAIL / 13 skips. Причина видимости окружения неизвестна. Локальные focused PASS не заменяют исполнение исправления на release runner, полный gate, подписи или проверенный pin.
