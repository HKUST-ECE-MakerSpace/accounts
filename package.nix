{
  lib,
  stdenv,
  nodejs_24,
  makeWrapper,
}:

# Plain copy derivation: the service has zero npm dependencies, so there is
# nothing to build — just ship src/*.js and a wrapper that runs them with
# Node 24 (built-in node:sqlite needs >= 22.5; 24 also matches the target
# server). Environment flows through unchanged (systemd / shell supplies it).
stdenv.mkDerivation (finalAttrs: {
  pname = "accounts";
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

  src = lib.cleanSourceWith {
    src = ./.;
    filter =
      path: type:
      let
        rel = lib.removePrefix (toString ./.) (toString path);
        top = builtins.head (lib.splitString "/" rel);
      in
      !builtins.elem top [
        ".git"
        ".env"
        "data"
        "node_modules"
        "result"
        "test"
      ];
  };

  dontBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/accounts $out/bin
    cp src/*.js $out/share/accounts/
    makeWrapper ${nodejs_24}/bin/node $out/bin/accounts-server \
      --add-flags "$out/share/accounts/server.js"
    runHook postInstall
  '';

  meta = {
    description = "ECE Makerspace account service — PIN auth with email magic-link reset";
    homepage = "https://accounts.ecemaker.space";
    license = lib.licenses.mit;
    mainProgram = "accounts-server";
  };
})
