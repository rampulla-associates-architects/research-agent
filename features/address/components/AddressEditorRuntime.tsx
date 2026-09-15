type AddressRecord = {
  title: string;
  subtitle: string;
};

export function createAddressController({ onAddressClick }: { onAddressClick?: (address: AddressRecord) => void } = {}) {
  const addresses: AddressRecord[] = [];

  function add(searchResult: any) {
    const feature = searchResult.features && searchResult.features[0];
    const properties = feature && feature.properties ? feature.properties : {};
    const title = properties.full_address || properties.name || properties.address || "Selected place";
    const subtitle = properties.place_formatted || properties.context?.place?.name || "Search result";
    const address = { title, subtitle };

    addresses.unshift(address);
    onAddressClick?.(address);
    return address;
  }

  function getCurrentAddress() {
    return addresses[0] || null;
  }

  return { add, getCurrentAddress };
}
