{ config, lib, pkgs, ... }:

with lib;

# Optional autostart for awui as a systemd user service, managed
# declaratively by home-manager. Build the app first (`npm ci && npm run build`
# in appDir); after pulling, rebuild and restart the unit.
#            Status:     systemctl --user status awui
#            Logs:       journalctl --user -u awui -n 20
#            Restart:    systemctl --user restart awui
#            Uninstall:  set services.awui.enable = false (or remove the import) and rebuild.
#
# The mesh (peers on your own machines) can be declared here too, exactly as
# the NixOS module (../nixos/awui.nix) declares it; the rendered mesh block
# lands in ~/.config/awui/config.yml. Leave mesh and extraConfig empty to keep
# managing that file by hand (the Settings dialog writes it) — declaring them
# makes the file a home-manager symlink, and the Settings dialog never edits a
# symlinked config, so user settings then belong in extraConfig and a rebuild.

let
  # Point this at your checkout of the repository.
  appDir = "%h/.../webui";
  cfg = config.services.awui;
  settingsFormat = pkgs.formats.yaml { };

  # One mesh.peers entry; the nulls never reach the YAML (pkgs.formats.yaml has
  # no null), so peerYaml keeps only what is set. Kept in step with the NixOS
  # module's peerType — the two files are standalone templates, so the shape is
  # duplicated on purpose rather than imported across contrib/.
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

  meshYaml = optionalAttrs cfg.mesh.enable (
    {
      enabled = true;
    }
    // optionalAttrs (cfg.mesh.name != null) { name = cfg.mesh.name; }
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
  declaredConfig = {
    mesh = meshYaml;
  } // cfg.extraConfig;
in
{
  options.services.awui = {
    # True by default so an existing import of this file keeps defining the
    # unit it always defined; set false (or drop the import) to remove it.
    enable = mkOption {
      type = types.bool;
      default = true;
      description = "Define the awui user service.";
    };

    mesh = {
      enable = mkEnableOption "the awui mesh (delegated tasks on your own machines; off until this is set)";
      name = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "This machine's mesh name (default: the hostname, as awui spells it).";
      };
      listen = {
        host = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "The address the direct-TLS listener binds. With no listen block the mesh stays outbound-only: nothing accepts inbound links.";
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
        description = "home-manager cannot open a port (it belongs to NixOS's networking.firewall); this option exists so the same mesh block evaluates in both modules, and only warns.";
      };
      policies = mkOption {
        type = types.attrsOf settingsFormat.type;
        default = { };
        description = "mesh.policies entries as config.yml spells them; an entry merges over the built-in of the same name (none, worker, peer), and \"none\" can never be overridden.";
        example = literalExpression ''
          {
            worker.roots = [ "~/code" ];
          }
        '';
      };
      peers = mkOption {
        type = types.listOf peerType;
        default = [ ];
        description = "The peers this machine may reach (and, for inbound_policy, what arriving callers are held to).";
      };
    };

    extraConfig = mkOption {
      type = settingsFormat.type;
      default = { };
      description = "config.yml keys merged over the mesh block (recursively; extraConfig wins). Declaring it makes the file a home-manager symlink that the Settings dialog never writes, so user settings belong here.";
    };
  };

  config = mkMerge [
    {
      warnings = mkIf cfg.mesh.openFirewall [
        "services.awui.mesh.openFirewall does nothing under home-manager: open the mesh listener's port in NixOS's networking.firewall.allowedTCPPorts yourself."
      ];
    }

    (mkIf cfg.enable {
      systemd.user.services.awui = {
        Unit = {
          Description = "awui: the web UI for Pi, omp, Hermes, and Claude Code";
          # No build yet (or no checkout on this machine): skip instead of restart-looping.
          ConditionPathExists = "${appDir}/dist/server/server/index.js";
        };
        Service = {
          ExecStart = "${lib.getExe pkgs.nodejs} ${appDir}/dist/server/server/index.js";
          WorkingDirectory = appDir;
          # Port, host and the login come from ~/.config/awui/config.yml; anything set here
          # would override that file.
          Environment = [
            # The shell's toolset: pi and omp live outside the Nix profile, and the
            # agents' own tools (git, rg, sudo, cargo, ...) need the rest.
            "PATH=%h/.local/bin:%h/.node_modules/bin:%h/.cargo/bin:%h/.bun/bin:/run/wrappers/bin:${config.home.profileDirectory}/bin:/etc/profiles/per-user/${config.home.username}/bin:/run/current-system/sw/bin"
          ];
          # SIGTERM is a clean exit (0), so "on-failure" would leave it dead after a stray kill.
          Restart = "always";
          RestartSec = 5;
          # 78 = bad settings (e.g. HOST=0.0.0.0 without a login): stop and say why in the journal.
          RestartPreventExitStatus = 78;
        };
        Install.WantedBy = [ "default.target" ];
      };
    })

    (mkIf (cfg.mesh.enable || cfg.extraConfig != { }) {
      # The declared mesh block (and extraConfig) as config.yml. If a hand-written
      # config.yml is already there, home-manager refuses the conflict: move its
      # content into extraConfig (and the mesh options), then rebuild.
      xdg.configFile."awui/config.yml" = {
        source = settingsFormat.generate "awui-config.yml" declaredConfig;
        # The Settings dialog reads it (and, being a symlink, refuses to edit it).
      };
    })
  ];
}
