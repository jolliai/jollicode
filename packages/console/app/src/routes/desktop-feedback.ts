import { redirect } from "@solidjs/router"

export async function GET() {
  return redirect("https://github.com/jolliai/jollicode/issues")
}
