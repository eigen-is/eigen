# Local S3 testing with MinIO

Runs a local S3-compatible server for testing Eigen's S3 storage backend.

## Start

```bash
cd scripts/s3-local
docker compose up -d
```

## Configure Eigen

In the admin settings (or via `PUT /settings/s3config`), use:

| Field      | Value                                                         |
|------------|---------------------------------------------------------------|
| Endpoint   | `http://localhost:9000` or `http://host.docker.internal:9000` | 
| Bucket     | `eigen`                                                       |
| Prefix     | `test`                                                        |
| Access Key | `minioadmin`                                                  |
| Secret Key | `minioadmin`                                                  |
| Region     | `eu-west-1`                                                   |

Use `POST /settings/s3check` to verify the connection, then set storage type to `s3`.

## Run the S3 test suite against it

```bash
cd apps/api
S3_TEST_ENDPOINT=http://localhost:9000 bun test src/test/storage/s3-minio.test.ts --preload ./src/test/preload.ts
```

Without `S3_TEST_ENDPOINT` the suite skips cleanly (CI never sets it).

## MinIO Console

Browse stored objects at [http://localhost:9001](http://localhost:9001) (login: `minioadmin` / `minioadmin`).

## Stop

```bash
docker compose down        # keep data
docker compose down -v     # delete data
```
