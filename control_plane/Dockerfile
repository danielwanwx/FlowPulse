FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml ./
COPY flowpulse_cp ./flowpulse_cp
COPY tests ./tests
RUN pip install --no-cache-dir .
EXPOSE 8090
CMD ["python", "-m", "flowpulse_cp.main"]
