FROM python:3.11-slim
ARG FLOWPULSE_PRODUCER_GIT_SHA=unattested
ARG FLOWPULSE_WORKSPACE_WORKFLOW_BLOB_OID=unattested
LABEL io.flowpulse.producer_git_sha=$FLOWPULSE_PRODUCER_GIT_SHA \
      io.flowpulse.workspace_workflow_blob_oid=$FLOWPULSE_WORKSPACE_WORKFLOW_BLOB_OID
WORKDIR /app
COPY pyproject.toml ./
COPY flowpulse_cp ./flowpulse_cp
COPY tests ./tests
COPY tools ./tools
RUN pip install --no-cache-dir .
EXPOSE 8090
CMD ["python", "-m", "flowpulse_cp.main"]
