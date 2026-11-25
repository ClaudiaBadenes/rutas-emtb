#!/usr/bin/env bash
# Arranca GraphHopper (la primera vez importa el OSM + altimetría y tarda unos minutos).
set -euo pipefail
cd "$(dirname "$0")"
JAVA="./jdk/Contents/Home/bin/java"
[ -x "$JAVA" ] || JAVA="java"
exec "$JAVA" -Xmx6g -Ddw.graphhopper.datareader.file=data/valencia-latest.osm.pbf \
  -jar graphhopper-web-11.1.jar server config.yml
