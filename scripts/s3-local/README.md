# Local S3 testing with MinIO

Runs a local S3-compatible server for testing Eigen's S3 storage backend.

## Start

```bash
cd scripts/s3-local
docker compose up -d
```

## Configure Eigen

In the admin settings (or via `PUT /settings/s3config`), use:

| Field      | Value                    |
|------------|--------------------------|
| Endpoint   | `http://localhost:9000`  |
| Bucket     | `eigen`                  |
| Prefix     | `test`                   |
| Access Key | `minioadmin`             |
| Secret Key | `minioadmin`             |
| Region     | `us-east-1`             |

Use `POST /settings/s3check` to verify the connection, then set storage type to `s3`.

## MinIO Console

Browse stored objects at [http://localhost:9001](http://localhost:9001) (login: `minioadmin` / `minioadmin`).

## Stop

```bash
docker compose down        # keep data
docker compose down -v     # delete data
```
