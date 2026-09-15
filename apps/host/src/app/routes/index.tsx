// M0 の host は中身を持たない。SPAシェルが配られ、ブラウザで描画されることだけを示す。
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <h1>MUSUNEST</h1>;
}
