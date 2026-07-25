"""Postgres projection/event adapter. It never chooses the next workflow state."""

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from uuid import uuid4

import asyncpg

from .models import IncidentCase, TemporalActivityPacket


class PostgresCaseRepository:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.pool: Optional[asyncpg.Pool] = None

    async def connect(self) -> None:
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def _pool(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("postgres_repository_not_connected")
        return self.pool

    async def _execute_for_tenant(self, tenant_id: str, query: str, *args: Any) -> None:
        async with self._pool().acquire() as connection:
            async with connection.transaction():
                await connection.execute("SELECT set_config('app.tenant_id', $1, true)", tenant_id)
                await connection.execute(query, *args)

    async def insert_case_if_absent(self, packet: TemporalActivityPacket) -> None:
        now = datetime.now(timezone.utc)
        payload = json.dumps(packet.dict(), default=str)
        await self._execute_for_tenant(
            packet.tenant_id,
            """
            INSERT INTO incident_cases
              (case_id, tenant_id, case_revision, workflow_id, workflow_run_id, state, payload, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,'RECEIVED',$6::jsonb,$7,$7)
            ON CONFLICT (case_id) DO NOTHING
            """,
            packet.case_id, packet.tenant_id, packet.case_revision,
            "flowpulse.diagnosis:{}".format(packet.case_id), packet.workflow_run_id, payload, now,
        )

    async def append_activity_event(
        self, packet: TemporalActivityPacket, result: Dict[str, Any], raw_artifact_key: Optional[str] = None
    ) -> None:
        payload = json.dumps(
            {"packet": packet.dict(), "result": result, "raw_artifact_key": raw_artifact_key}, default=str
        )
        await self._execute_for_tenant(
            packet.tenant_id,
            """
            INSERT INTO case_events (event_id, case_id, tenant_id, event_type, payload, occurred_at)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6)
            """,
            uuid4(), packet.case_id, packet.tenant_id, "activity." + packet.stage,
            payload, datetime.now(timezone.utc),
        )

    async def append_verification(self, packet: TemporalActivityPacket, result: Dict[str, Any]) -> None:
        await self._execute_for_tenant(
            packet.tenant_id,
            """
            INSERT INTO verification_reports
              (verification_id, case_id, tenant_id, verifier_identity, decision, payload, created_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
            ON CONFLICT (verification_id) DO NOTHING
            """,
            "verify-{}-{}".format(packet.case_id, packet.workflow_run_id),
            packet.case_id, packet.tenant_id, result["identity"], result["decision"],
            json.dumps(result), datetime.now(timezone.utc),
        )
