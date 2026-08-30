from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_base_url: str = "http://localhost:3000/api"
    # Worker authentication token (get from backend via: node -e "console.log(require('jsonwebtoken').sign({sub:'worker',type:'worker'}, process.env.JWT_SECRET || 'CHANGE_ME', {expiresIn:'365d'}))")
    worker_auth_token: str = ""
    poll_interval_seconds: int = 5
    worker_name: str = "netconsole-worker-1"
    worker_concurrency: int = 4
    lab_ssh_enabled: bool = False
    lab_ssh_user: str = "lab"
    lab_ssh_password: str = "lab123"
    lab_ssh_port: int = 22
    junos_rest_enabled: bool = False
    junos_rest_scheme: str = "https"
    junos_rest_port: int = 8443
    junos_rest_verify_tls: bool = False
    junos_rest_user: str = ""
    junos_rest_password: str = ""


settings = Settings()
