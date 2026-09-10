self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.accounts;
in
{
  options.services.accounts = with lib; {
    enable = mkEnableOption "accounts (ECE Makerspace account service)";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "accounts package to run";
    };

    port = mkOption {
      type = types.port;
      default = 3100;
      description = "Port the server listens on (localhost only, behind Caddy)";
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/accounts";
      description = ''
        Persistent state: the SQLite database (accounts.db). An optional env
        file for mail secrets can be placed at ''${stateDir}/env — see the
        README (PA_MAIL_URL, PA_MAIL_TOKEN, MAIL_DEV, MAIL_DEV_EMAIL).
      '';
    };

    adminItsces = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        ITSC logins that become admins on first login (ADMIN_ITSCS,
        comma-joined).
      '';
    };

    domain = mkOption {
      type = types.str;
      default = "accounts.ecemaker.space";
      description = ''
        Caddy vhost serving the service; magic links point at
        https://''${domain}.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.accounts = {
      description = "accounts — ECE Makerspace account service";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      environment = {
        PORT = toString cfg.port;
        DATA_DIR = cfg.stateDir;
        PUBLIC_BASE_URL = "https://${cfg.domain}";
        ADMIN_ITSCS = concatStringsSep "," cfg.adminItsces;
      };

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/accounts-server";
        # Optional mail overrides/secrets (PA_MAIL_URL, PA_MAIL_TOKEN and the
        # MAIL_DEV + MAIL_DEV_EMAIL dev gate); leading "-" = optional.
        EnvironmentFile = "-${cfg.stateDir}/env";
        DynamicUser = true;
        StateDirectory = "accounts";
        Restart = "on-failure";
        RestartSec = "3";

        # hardening: everything read-only except the state dir
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        LockPersonality = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
      };
    };

    services.caddy.virtualHosts."${cfg.domain}" = {
      extraConfig = ''
        # /track/* is reserved for the workshop tracker, mounted later by
        # this same service — it already proxies to the accounts backend,
        # which owns the routing (404 until the tracker lands).
        handle /track/* {
          reverse_proxy localhost:${toString cfg.port}
        }
        handle {
          reverse_proxy localhost:${toString cfg.port}
        }
      '';
    };
  };
}
