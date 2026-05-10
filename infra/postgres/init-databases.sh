#!/usr/bin/env bash
# Creates one database per microservice.
# This script is executed by the postgres container on first startup.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
    CREATE DATABASE catalog_db;
    CREATE DATABASE order_db;
    CREATE DATABASE identity_db;
    CREATE DATABASE inventory_db;
    CREATE DATABASE payment_db;
EOSQL

echo "All microservice databases created."
