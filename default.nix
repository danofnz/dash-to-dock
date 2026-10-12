with import <nixpkgs> {};
stdenv.mkDerivation {
    name = "dash-to-dock-with-groups";
    buildInputs = [ gnumake glib sassc ];
}
