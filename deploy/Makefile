# Shortcuts for the Docker deployment. Run from deploy/:  make deploy
COMPOSE = docker compose -f compose.yaml

.PHONY: deploy deploy-local logs status restart stop backup

deploy:        ## pull, build, restart with minimal downtime
	./deploy.sh

deploy-local:  ## same, without git pull
	SKIP_PULL=1 ./deploy.sh

logs:          ## follow the app's logs
	$(COMPOSE) logs -f --tail 100 web

status:        ## container state and health endpoint
	$(COMPOSE) ps
	@curl -fsS http://127.0.0.1:3100/api/v1/health && echo

restart:
	$(COMPOSE) restart web

stop:
	$(COMPOSE) down

backup:        ## copy the SQLite database (encrypted data only) to ./kaizen-backup.db
	$(COMPOSE) exec -T web node -e "require('better-sqlite3')(process.env.KAIZEN_DB_PATH,{readonly:true}).backup('/tmp/kaizen-backup.db').then(()=>process.stdout.write(require('fs').readFileSync('/tmp/kaizen-backup.db')))" > kaizen-backup.db
	@ls -l kaizen-backup.db
