import MemberPage from "@/components/MemberPage";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <MemberPage handle={handle} />;
}
