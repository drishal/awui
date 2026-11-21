{ config, lib, pkgs, ... }:

with lib;

# awui as a NixOS system service, with the mesh (peers on your own machines) as
# a submodule. The mesh block is rendered into config.yml with
# pkgs.formats.yaml, so the file awui reads stays declarative: a rebuild
# changes policy and peers, and nothing on the running machine edits it (the
# Settings dialog cannot save here — put user settings in extraConfig and
# rebuild). Because the config is rendered, it carries no secrets.
#
#   services.awui = {
#     enable = true;
#     # package = ...;              # a checkout built with `npm ci && npm run build`
#     #                              # (bin/awui on its PATH output), or the compiled binary
#     readWritePaths = [ "/srv/code" ];   # every folder agents work in
#     mesh = {
#       enable = true;
#       listen = { host = "192.168.1.10"; };   # inbound direct-TLS links; omit for a leader-only node
#       policies.worker.roots = [ "/srv/code" ];
#       peers = [{ name = "nixos-desktop"; tls = "192.168.1.20:4784"; }];
#     };
#   };
#
# Status: systemctl status awui — Logs: journalctl -u awui -n 20
# The mesh parts are documented in docs/mesh.md, including a two-machine
# example and `awui peer bootstrap` for a machine this module does not manage.

let
  cfg = config.services.awui;
  settingsFormat = pkgs.formats.yaml { };

  # One mesh.peers entry, exactly the keys awui's schema knows; a peer names
  # exactly one of ssh / docker / tls. The nulls never reach the YAML
  # (pkgs.formats.yaml has no null), so peerYaml keeps only what is set.
  peerType = types.submodule {
    options = {
      name = mkOption { type = types.str; description = "The peer's name as config.yml spells it (letters, digits, '.', '_', '-')."; };
      ssh = mkOption { type = types.nullOr types.str; default = null; description = "[user@]host for an SSH stdio link."; };
      docker = mkOption { type = types.nullOr types.str; default = null; description = "Container name or id for a docker/podman exec link."; };
      tls = mkOption { type = types.nullOr types.str; default = null; description = "\"host:port\" for a direct TLS link (P2); the key is pinned, the certificate is not trusted."; };
      ssh_opts = mkOption { type = types.listOf types.str; default = [ ]; description = "Extra ssh argv words (never a shell string)."; };
      awui_path = mkOption { type = types.nullOr types.str; default = null; description = "The remote awui binary when it is not on the remote PATH."; };
      engine = mkOption { type = types.nullOr (types.enum [ "docker" "podman" ]); default = null; description = "The container runtime (default docker)."; };
      inbound_policy = mkOption { type = types.nullOr types.str; default = null; description = "The policy a caller arriving under this peer's name is held to."; };
    };
  };
  peerYaml = p:
    { name = p.name; }
    // optionalAttrs (p.ssh != null) { inherit (p) ssh; }
    // optionalAttrs (p.docker != null) { inherit (p) docker; }
    // optionalAttrs (p.tls != null) { inherit (p) tls; }
    // optionalAttrs (p.ssh_opts != [ ]) { inherit (p) ssh_opts; }
    // optionalAttrs (p.awui_path != null) { inherit (p) awui_path; }
    // optionalAttrs (p.engine != null) { inherit (p) engine; }
    // optionalAttrs (p.inbound_policy != null) { inherit (p) inbound_policy; };

  # The mesh submodule: enable, name, the direct-TLS listener, and the
  # declarative half of pairing (policies and peers). The key pins, the audit
  # log and the attach socket live in the state directory, not here.
  meshOpts = {
    options = {
      enable = mkEnableOption "the awui mesh (delegated tasks on your own machines; off until this is set)";
      name = mkOption {
        type = types.str;
        default = config.networking.hostName;
        description = "This node's mesh name, as pairing and forced commands spell it.";
      };
      listen = {
        host = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "The address the direct-TLS listener binds (an IP or hostname; 0.0.0.0/:: work but the doctor warns). With no listen block the mesh stays outbound-only: nothing accepts inbound links.";
        };
        port = mkOption {
          type = types.port;
          default = 4784;
          description = "The direct-TLS listener's port.";
        };
      };
      openFirewall = mkOption {
        type = types.bool;
        default = false;
        description = "Open mesh.listen.port in networking.firewall. Off by default: the listener speaks only awui-mesh/1, but an open port is still a decision to make on purpose.";
      };
      policies = mkOption {
        type = types.attrsOf settingsFormat.type;
        default = { };
        description = ''
          mesh.policies entries as config.yml spells them (caps, ask, roots, harnesses,
          permission_ceiling, max_tasks, max_file_bytes, approvals_at). The built-ins
          (none, worker, peer) still exist under these names; an entry merges over its
          built-in, and "none" can never be overridden. Roots must be absolute for a
          system service (no ~).
        '';
        example = literalExpression ''
          {
            worker.roots = [ "/srv/code" ];
          }
        '';
      };
      peers = mkOption {
        type = types.listOf peerType;
        default = [ ];
        description = "The peers this machine may reach (and, for inbound_policy, what arriving callers are held to).";
      };
    };
  };

  # config.yml as awui reads it: the service's own settings, the mesh block when
  # it is on, and extraConfig last (recursiveUpdate, so it wins).
  meshYaml = optionalAttrs cfg.mesh.enable (
    {
      enabled = true;
      name = cfg.mesh.name;
    }
    // optionalAttrs (cfg.mesh.listen.host != null) {
      listen = { inherit (cfg.mesh.listen) host port; };
    }
    // optionalAttrs (cfg.mesh.policies != { }) {
      policies = cfg.mesh.policies;
    }
    // optionalAttrs (cfg.mesh.peers != [ ]) {
      peers = map peerYaml cfg.mesh.peers;
    }
  );
  configYaml = settingsFormat.generate "awui-config.yml" (
    {
      port = cfg.port;
      host = cfg.host;
    }
    // optionalAttrs (meshYaml != { }) { mesh = meshYaml; }
    // cfg.extraConfig
  );

  # Every folder the service may write: state, workspace roots, and the roots
  # the mesh policies name (absolute only; ~ makes no sense for a system user).
  policyRoots = flatten (mapAttrsToList (_: policy: policy.roots or [ ]) cfg.mesh.policies);
in
{
  options.services.awui = {
    enable = mkEnableOption "awui: the web UI for Pi, omp, Hermes, Claude Code, and the other coding agents";

    package = mkPackageOption pkgs "awui" {
      example = "pkgs.awui";
      # A checkout built with `npm ci && npm run build` also works: it must
      # provide bin/awui (meta.mainProgram "awui"), which runs the server.
    };

    user = mkOption {
      type = types.str;
      default = "awui";
      description = "The service runs as this user; the built-in one is created, a custom one must already exist (and be in the awui group).";
    };

    group = mkOption {
      type = types.str;
      default = "awui";
      description = "The group the config file and the runtime directory are held to; the built-in one is created.";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/awui";
      description = "The state folder (identity, pins, audit log, attach socket). Outside /var/lib it is created before the service starts.";
    };

    port = mkOption {
      type = types.port;
      default = 4783;
      description = "The web server's port (127.0.0.1 unless host says otherwise); rendered into config.yml, so the setting and the file agree.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "The web server's bind address; 0.0.0.0 serves the LAN and needs a login (config.yml or extraConfig's device logins).";
    };

    readWritePaths = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Folders the agents work in. ProtectSystem=strict makes the whole tree read-only, so every project folder must be listed here.";
      example = [ "/srv/code" ];
    };

    extraConfig = mkOption {
      type = settingsFormat.type;
      default = { };
      description = "config.yml keys merged over the ones above (recursively; extraConfig wins). The Settings dialog cannot write a rendered config, so user settings belong here.";
    };

    mesh = meshOpts;
  };

  config = mkIf cfg.enable (mkMerge [
    {
      assertions = [
        {
          assertion = cfg.user == "awui" || config.users.users ? ${cfg.user};
          message = "services.awui.user is set to \"${cfg.user}\", which no user block creates; add users.users.\"${cfg.user}\".";
        }
        {
          assertion = (cfg.mesh.listen.host != null) -> !(hasInfix "localhost" cfg.mesh.listen.host);
          message = "services.awui.mesh.listen.host binds the direct-TLS listener; a hostname that resolves to loopback would answer on the loopback interface only. Use the machine's LAN address (or 0.0.0.0, which the doctor warns about).";
        }
      ];

      users.groups = mkIf (cfg.group == "awui") { awui = { }; };
      users.users = mkIf (cfg.user == "awui") {
        awui = {
          isSystemUser = true;
          group = cfg.group;
          description = "awui service user";
          home = cfg.stateDir;
        };
      };

      environment.etc."awui/config.yml" = {
        source = configYaml;
        mode = "0400";
        user = cfg.user;
        group = cfg.group;
      };

      networking.firewall.allowedTCPPorts = mkIf (cfg.mesh.enable && cfg.mesh.openFirewall) [ cfg.mesh.listen.port ];

      systemd.services.awui = {
        description = "awui: the web UI for Pi, omp, Hermes, and Claude Code";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];

        serviceConfig = {
          Type = "exec";
          User = cfg.user;
          Group = cfg.group;
          # Port, host, and the mesh come from the rendered config.yml.
          ExecStart = "${getExe cfg.package}";
          Environment = [
            "AWUI_CONFIG_DIR=/etc/awui"
            "AWUI_STATE_DIR=${cfg.stateDir}"
            "XDG_RUNTIME_DIR=/run/awui"
          ];
          # The attach socket: /run/awui/awui-mesh.sock, 0600 in this 0700 directory.
          RuntimeDirectory = "awui";
          RuntimeDirectoryMode = "0700";
          StateDirectory = mkIf (cfg.stateDir == "/var/lib/awui") "awui";
          StateDirectoryMode = "0700";
          ExecStartPre =
            mkIf (cfg.stateDir != "/var/lib/awui")
              "+${pkgs.coreutils}/bin/mkdir -p ${cfg.stateDir}";
          # The hardening the spec asks for: the state folder and the folders
          # agents work in are the only writable places, /tmp is private (the
          # paste store lives there), and the sockets awui needs are the Unix
          # one and IP. ProtectHome is left off on purpose: project folders
          # under /home are writable only when readWritePaths names them.
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ReadWritePaths = [ cfg.stateDir "/etc/awui" ] ++ cfg.readWritePaths ++ policyRoots;
          PrivateTmp = true;
          RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
          Restart = "on-failure";
          RestartSec = 5;
          # 78 = bad settings (HOST=0.0.0.0 without a login, a broken config.yml):
          # stop and say why in the journal, don't restart into the same refusal.
          RestartPreventExitStatus = 78;
        };
      };
    }
  ]);
}
