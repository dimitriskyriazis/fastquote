import ContactGroupDetailClient from "./ContactGroupDetailClient";

export default async function Page({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  return <ContactGroupDetailClient groupId={groupId} />;
}
