import paramiko


def run_ssh_command(
    host: str,
    username: str,
    password: str,
    command: str,
    port: int = 22,
    timeout: int = 15,
    input_text: str | None = None,
) -> dict:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            timeout=timeout,
            look_for_keys=False,
            allow_agent=False,
        )

        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        if input_text is not None:
            stdin.write(input_text if input_text.endswith("\n") else input_text + "\n")
            stdin.channel.shutdown_write()
        else:
            del stdin
        output = stdout.read().decode("utf-8", errors="replace")
        err_text = stderr.read().decode("utf-8", errors="replace")
        exit_status = stdout.channel.recv_exit_status()

        if exit_status != 0:
            return {
                "sshOk": False,
                "output": output,
                "error": err_text.strip() or f"SSH command exited with status {exit_status}",
            }

        return {
            "sshOk": True,
            "output": output if output else err_text,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - lab boundary
        return {
            "sshOk": False,
            "output": "",
            "error": str(exc),
        }
    finally:
        client.close()


def run_junos_commands(
    host: str,
    username: str,
    password: str,
    port: int = 22,
    timeout: int = 15,
) -> dict:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            timeout=timeout,
            look_for_keys=False,
            allow_agent=False,
        )

        def exec_cmd(command: str) -> str:
            stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
            del stdin
            output = stdout.read().decode("utf-8", errors="replace")
            err_text = stderr.read().decode("utf-8", errors="replace")
            exit_status = stdout.channel.recv_exit_status()
            if exit_status != 0:
                raise RuntimeError(err_text.strip() or f"exit {exit_status}")
            return output if output else err_text

        show_version = exec_cmd("show version")
        show_run = exec_cmd("show configuration | display set")

        return {
            "sshOk": True,
            "showVersion": show_version,
            "showRun": show_run,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - lab boundary
        return {
            "sshOk": False,
            "showVersion": "",
            "showRun": "",
            "error": str(exc),
        }
    finally:
        client.close()
