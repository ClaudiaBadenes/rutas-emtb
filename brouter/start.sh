#!/usr/bin/env bash
# Servidor BRouter local (mismo programa y mapas que brouter.de) en el puerto 17777
cd "$(dirname "$0")"
JAVA="../engine/jdk/Contents/Home/bin/java"
[ -x "$JAVA" ] || JAVA="java"
exec "$JAVA" -Xmx1g -cp dist/brouter-1.7.10/brouter-1.7.10-all.jar btools.server.RouteServer segments4 profiles customprofiles 17777 4
