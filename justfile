# Default behavior: print available recipes.
default: list

# List all available recipes.
list:
  @just --list

dev:
  infisical run -- pnpm run dev

build:
  infisical run -- pnpm run build

start:
  infisical run -- pnpm run start

lint:
  infisical run -- pnpm run lint

prisma-generate:
  infisical run -- pnpm run prisma:generate
prisma-push:
  infisical run -- pnpm exec prisma db push

prisma-migrate-dev:
  infisical run -- pnpm run prisma:migrate:dev

prisma-migrate-deploy:
  infisical run -- pnpm run prisma:migrate:deploy

prisma-studio:
  infisical run -- pnpm run prisma:studio
