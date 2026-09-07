from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_base_url: str = "http://localhost:3000/api"
    # Worker authentication token (get from backend via: node -e "console.log(require('jsonwebtoken').sign({sub:'worker',type:'worker'}, process.env.JWT_SECRET || 'CHANGE_ME', {expiresIn:'365d'}))")
    worker_auth_token: str = ""
    poll_interval_seconds: int = 5
    worker_name: str = "netconsole-worker-1"
    worker_concurrency: int = 4

    # SSH — shared across all vendor backends as the fallback transport.
    lab_ssh_enabled: bool = False
    lab_ssh_user: str = "lab"
    lab_ssh_password: str = "lab123"
    lab_ssh_port: int = 22

    # Juniper Junos — RESTCONF (existing).
    junos_rest_enabled: bool = False
    junos_rest_scheme: str = "https"
    junos_rest_port: int = 8443
    junos_rest_verify_tls: bool = False
    junos_rest_user: str = ""
    junos_rest_password: str = ""

    # Arista EOS — eAPI JSON-RPC.
    eos_api_enabled: bool = False
    eos_api_scheme: str = "https"
    eos_api_port: int = 443
    eos_api_verify_tls: bool = False
    eos_api_user: str = ""
    eos_api_password: str = ""

    # Cisco IOS-XE — RESTCONF + SSH CLI fallback.
    iosxe_api_enabled: bool = False
    iosxe_api_scheme: str = "https"
    iosxe_api_port: int = 443
    iosxe_api_verify_tls: bool = False
    iosxe_api_user: str = ""
    iosxe_api_password: str = ""

    # Cisco NX-OS — NX-API REST + NX-API CLI.
    nxos_api_enabled: bool = False
    nxos_api_scheme: str = "http"
    nxos_api_port: int = 80
    nxos_api_verify_tls: bool = False
    nxos_api_user: str = ""
    nxos_api_password: str = ""


settings = Settings()
