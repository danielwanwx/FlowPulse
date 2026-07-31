#!/bin/sh
set -eu

until mc alias set flowpulse "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do
  sleep 1
done
mc mb --ignore-existing "flowpulse/$FLOWPULSE_OBJECT_STORE_BUCKET"
mc mb --ignore-existing "flowpulse/$FLOWPULSE_SOURCE_READ_BUCKET"
mc admin user add flowpulse "$FLOWPULSE_OBJECT_STORE_ACCESS_KEY" "$FLOWPULSE_OBJECT_STORE_SECRET_KEY" || true
mc admin user add flowpulse "$FLOWPULSE_SOURCE_READ_ACCESS_KEY" "$FLOWPULSE_SOURCE_READ_SECRET_KEY" || true
mc admin policy create flowpulse flowpulse-artifact-writer /policies/artifact-writer.json || true
mc admin policy create flowpulse flowpulse-source-reader /policies/source-reader.json || true
mc admin policy attach flowpulse flowpulse-artifact-writer --user "$FLOWPULSE_OBJECT_STORE_ACCESS_KEY" || true
mc admin policy attach flowpulse flowpulse-source-reader --user "$FLOWPULSE_SOURCE_READ_ACCESS_KEY" || true
mc cp /fixtures/source-readback.json "flowpulse/$FLOWPULSE_SOURCE_READ_BUCKET/controlled/tenant-minio/cases/case-minio/revisions/1/evidence/ev-minio/v1.json"
# Seed an existing neighboring tenant object. The tenant-minio reader policy
# must reject this raw object request before adapter-level validation runs.
mc cp /fixtures/source-readback.json "flowpulse/$FLOWPULSE_SOURCE_READ_BUCKET/controlled/tenant-other/cases/case-other/revisions/1/evidence/ev-other/v1.json"
